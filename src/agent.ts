import type { RpcChild, RpcRecord, UiRequest } from "./rpc.ts";

export type AgentState = "starting" | "running" | "idle" | "failed" | "stopped";

/** One entry of a subagent's transcript, as the live view shows it. */
export type TranscriptItem =
	| { kind: "prompt"; text: string; via: "task" | "steer" | "follow-up" | "message" }
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool"; id: string; name: string; args: Record<string, unknown>; status: "running" | "done" | "error"; output: string }
	| { kind: "notice"; text: string; level: "info" | "warning" | "error" };

export interface AgentUsage {
	/** Input tokens, including cache reads and writes. */
	input: number;
	output: number;
	cost: number;
}

export interface AgentInfo {
	name: string;
	type: string;
	task: string;
	/** `provider/model` the agent is on right now. */
	model: string;
	thinking?: string;
	sessionFile: string;
}

/** Called for questions from extensions inside the subagent; resolve with the user's answer. */
export type QuestionHandler = (agent: Subagent, request: UiRequest) => Promise<{ value?: string; confirmed?: boolean; cancelled?: boolean }>;

const TOOL_OUTPUT_LIMIT = 4_000;

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => typeof part?.text === "string" && part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Pi's usage record as tokens in (including cache reads and writes), tokens out and cost. */
function usageOf(value: unknown): AgentUsage {
	const usage = (value ?? {}) as Record<string, unknown>;
	const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) ? field : 0);
	return {
		input: number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite),
		output: number(usage.output),
		cost: number((usage.cost as Record<string, unknown> | undefined)?.total),
	};
}

function shortPath(value: unknown): string {
	return typeof value === "string" ? value.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "") : "";
}

/** "$ npm test", "reading src/auth.ts", "editing src/a.ts": what a tool call is doing, in a few words. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
			return `$ ${String(args.command ?? "").split("\n")[0]}`;
		case "read":
			return `reading ${shortPath(args.path)}`;
		case "edit":
			return `editing ${shortPath(args.path)}`;
		case "write":
			return `writing ${shortPath(args.path)}`;
		case "grep":
			return `searching for ${String(args.pattern ?? "")}`;
		case "find":
			return `finding ${String(args.pattern ?? "")}`;
		case "ls":
			return `listing ${shortPath(args.path) || "."}`;
		default:
			return name;
	}
}

/**
 * A subagent: one Pi process in RPC mode, plus everything the tools and the UI need to know
 * about it, kept up to date from its event stream.
 */
export class Subagent {
	readonly info: AgentInfo;
	readonly createdAt = Date.now();
	state: AgentState = "starting";
	/** What it is doing right now, e.g. "$ npm test" or "thinking". */
	activity = "starting";
	/** Usage of finished replies; see `usage` for the live total. */
	private settledUsage: AgentUsage = { input: 0, output: 0, cost: 0 };
	/** Usage of the reply being streamed right now. */
	private streamingUsage: AgentUsage = { input: 0, output: 0, cost: 0 };
	readonly transcript: TranscriptItem[] = [];
	/** Its last answer, once it has finished a run. */
	result?: string;
	error?: string;
	/** Time spent running, excluding time idle. */
	private activeMs = 0;
	private runStartedAt?: number;
	private readonly child: RpcChild;
	private readonly listeners = new Set<() => void>();
	private settleWaiters: (() => void)[] = [];
	private currentText?: Extract<TranscriptItem, { kind: "text" }>;
	private currentThinking?: Extract<TranscriptItem, { kind: "thinking" }>;
	private lastAssistant?: { stopReason?: string; errorMessage?: string; text: string };

	constructor(info: AgentInfo, child: RpcChild, askQuestion: QuestionHandler) {
		this.info = info;
		this.child = child;
		child.onEvent((record) => this.handleEvent(record));
		child.onUiRequest((request) => this.handleUiRequest(request, askQuestion));
		void child.exited.then(() => {
			if (this.state === "stopped") return;
			this.finishRun();
			this.state = "failed";
			this.error ??= child.errorOutput.split("\n").slice(-3).join("\n") || "The subagent's Pi process exited.";
			this.activity = "exited";
			this.changed();
		});
	}

	/** Tokens and cost so far, including the reply being written right now. */
	get usage(): AgentUsage {
		return {
			input: this.settledUsage.input + this.streamingUsage.input,
			output: this.settledUsage.output + this.streamingUsage.output,
			cost: this.settledUsage.cost + this.streamingUsage.cost,
		};
	}

	/** Time spent running so far. */
	get elapsedMs(): number {
		return this.activeMs + (this.runStartedAt ? Date.now() - this.runStartedAt : 0);
	}

	get busy(): boolean {
		return this.state === "starting" || this.state === "running";
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Starts the first task. */
	async start(task: string): Promise<void> {
		this.transcript.push({ kind: "prompt", text: task, via: "task" });
		this.beginRun();
		await this.child.send({ type: "prompt", message: task });
	}

	/** Sends more input: steers a running agent, or starts a new run on an idle one. */
	async send(message: string, followUp = false): Promise<void> {
		if (this.state === "stopped" || !this.child.running) throw new Error(`${this.info.name} is no longer running.`);
		const via = !this.busy ? "message" : followUp ? "follow-up" : "steer";
		this.transcript.push({ kind: "prompt", text: message, via });
		this.changed();
		if (this.busy) {
			await this.child.send({ type: followUp ? "follow_up" : "steer", message });
		} else {
			this.beginRun();
			await this.child.send({ type: "prompt", message });
		}
	}

	/** Stops the current run but keeps the agent, so it can be given more work. */
	async abort(): Promise<void> {
		if (this.busy && this.child.running) await this.child.send({ type: "abort" });
	}

	/** Ends the agent and its process. */
	async stop(): Promise<void> {
		this.finishRun();
		this.state = "stopped";
		this.activity = "stopped";
		this.changed();
		this.wakeWaiters();
		await this.child.stop();
	}

	/** Resolves when the current run has finished (or right away when it is not running). */
	whenSettled(signal?: AbortSignal): Promise<void> {
		if (!this.busy) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				signal?.removeEventListener("abort", done);
				resolve();
			};
			this.settleWaiters.push(done);
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	private beginRun(): void {
		this.state = "running";
		this.activity = "starting";
		this.result = undefined;
		this.error = undefined;
		this.runStartedAt ??= Date.now();
		this.changed();
	}

	private finishRun(): void {
		if (this.runStartedAt) this.activeMs += Date.now() - this.runStartedAt;
		this.runStartedAt = undefined;
	}

	private wakeWaiters(): void {
		const waiters = this.settleWaiters;
		this.settleWaiters = [];
		for (const wake of waiters) wake();
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}

	private handleEvent(record: RpcRecord): void {
		switch (record.type) {
			case "agent_start":
				if (this.state !== "stopped") this.state = "running";
				break;
			case "message_update":
				this.streamingUsage = usageOf(record.usage);
				this.handleStreamEvent(record.assistantMessageEvent as RpcRecord | undefined);
				break;
			case "message_end":
				this.handleMessageEnd(record.message as Record<string, unknown> | undefined);
				break;
			case "tool_execution_start": {
				const args = (record.args ?? {}) as Record<string, unknown>;
				const name = String(record.toolName ?? "tool");
				this.transcript.push({ kind: "tool", id: String(record.toolCallId ?? ""), name, args, status: "running", output: "" });
				this.activity = describeToolCall(name, args);
				break;
			}
			case "tool_execution_end": {
				const item = this.transcript.findLast(
					(entry): entry is Extract<TranscriptItem, { kind: "tool" }> => entry.kind === "tool" && entry.id === record.toolCallId,
				);
				if (item) {
					item.status = record.isError ? "error" : "done";
					item.output = contentText((record.result as { content?: unknown } | undefined)?.content).slice(0, TOOL_OUTPUT_LIMIT);
				}
				this.activity = "thinking";
				break;
			}
			case "auto_retry_start":
				this.activity = "retrying";
				break;
			case "compaction_start":
				this.activity = "compacting";
				break;
			case "agent_settled":
				this.handleSettled(record.aborted === true);
				break;
			default:
				return;
		}
		this.changed();
	}

	private handleStreamEvent(event: RpcRecord | undefined): void {
		switch (event?.type) {
			case "text_start":
				this.currentText = { kind: "text", text: "" };
				this.transcript.push(this.currentText);
				this.activity = "writing";
				break;
			case "text_delta":
				if (this.currentText) this.currentText.text += String(event.delta ?? "");
				break;
			case "text_end":
				if (this.currentText && typeof event.content === "string") this.currentText.text = event.content;
				this.currentText = undefined;
				break;
			case "thinking_start":
				this.currentThinking = { kind: "thinking", text: "" };
				this.transcript.push(this.currentThinking);
				this.activity = "thinking";
				break;
			case "thinking_delta":
				if (this.currentThinking) this.currentThinking.text += String(event.delta ?? "");
				break;
			case "thinking_end":
				if (this.currentThinking && typeof event.content === "string") this.currentThinking.text = event.content;
				this.currentThinking = undefined;
				break;
		}
	}

	private handleMessageEnd(message: Record<string, unknown> | undefined): void {
		if (message?.role !== "assistant") return;
		const usage = usageOf(message.usage);
		this.settledUsage = {
			input: this.settledUsage.input + usage.input,
			output: this.settledUsage.output + usage.output,
			cost: this.settledUsage.cost + usage.cost,
		};
		this.streamingUsage = { input: 0, output: 0, cost: 0 };
		// The account can change mid-task (pi-multi-account switching), so follow every reply.
		if (typeof message.provider === "string" && typeof message.model === "string") {
			this.info.model = `${message.provider}/${message.model}`;
		}
		this.lastAssistant = {
			stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
			errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
			text: contentText(message.content),
		};
	}

	private handleSettled(aborted: boolean): void {
		if (this.state === "stopped") return;
		this.finishRun();
		const last = this.lastAssistant;
		if (aborted) {
			this.state = "idle";
			this.activity = "interrupted";
			this.result = last?.text || undefined;
		} else if (last?.stopReason === "error") {
			this.state = "failed";
			this.error = last.errorMessage ?? "The model returned an error.";
			this.activity = "failed";
		} else {
			this.state = "idle";
			this.activity = "done";
			this.result = last?.text ?? "";
		}
		this.wakeWaiters();
	}

	private handleUiRequest(request: UiRequest, askQuestion: QuestionHandler): void {
		if (request.method === "notify") {
			const level = request.notifyType === "error" || request.notifyType === "warning" ? request.notifyType : "info";
			this.transcript.push({ kind: "notice", text: String(request.message ?? ""), level });
			this.changed();
			return;
		}
		if (!["select", "confirm", "input", "editor"].includes(request.method)) return; // status, widgets, titles: not shown
		void askQuestion(this, request)
			.catch(() => ({ cancelled: true }))
			.then((answer) => this.child.respond(request.id, answer));
	}
}
