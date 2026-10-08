import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type QuestionHandler, Subagent } from "./agent.ts";
import type { AgentType } from "./agent-types.ts";
import { type PiCommand, RpcChild } from "./rpc.ts";

/** Set in every subagent's environment; pi-subagents stays passive there (no nested agents yet). */
export const CHILD_ENV = "PI_SUBAGENTS_CHILD";

/** At most this many agents exist at once; stopping one frees a place. */
export const MAX_AGENTS = 8;

export interface StartRequest {
	task: string;
	/** Agent type name; "worker" when absent. */
	type?: string;
	/** Short name shown in the UI; derived from the type when absent. */
	name?: string;
	/** `provider/model`; the agent type's or the parent's when absent. */
	model?: string;
}

export interface StartContext {
	cwd: string;
	/** The parent's `provider/model` and thinking level, inherited by default. */
	model?: string;
	thinking?: string;
	types: AgentType[];
}

export interface ManagerOptions {
	/** Where this session's subagent sessions are kept. */
	sessionDir: () => string;
	askQuestion: QuestionHandler;
	/** Tests: which Pi to run and extra arguments/environment for it. */
	pi?: PiCommand;
	extraArgs?: string[];
	env?: Record<string, string>;
}

function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "agent";
}

/** All subagents of one Pi session. */
export class AgentManager {
	private readonly options: ManagerOptions;
	private readonly agents = new Map<string, Subagent>();
	private readonly listeners = new Set<() => void>();

	constructor(options: ManagerOptions) {
		this.options = options;
	}

	list(): Subagent[] {
		return [...this.agents.values()];
	}

	get(name: string): Subagent | undefined {
		return this.agents.get(name);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Starts a subagent on its task. */
	async start(request: StartRequest, context: StartContext): Promise<Subagent> {
		const live = this.list().filter((agent) => agent.state !== "stopped");
		if (live.length >= MAX_AGENTS) {
			throw new Error(`There are already ${MAX_AGENTS} agents. Stop one with agent_stop first.`);
		}
		const typeName = request.type ?? "worker";
		const type = context.types.find((candidate) => candidate.name === typeName);
		if (!type) {
			const known = context.types.map((candidate) => candidate.name).join(", ");
			throw new Error(`Unknown agent type "${typeName}". Available: ${known}.`);
		}

		const name = this.uniqueName(slug(request.name ?? type.name));
		const dir = this.options.sessionDir();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const sessionFile = join(dir, `${name}.jsonl`);
		writeFileSync(sessionFile, "", { mode: 0o600 });

		const model = request.model ?? type.model ?? context.model;
		const thinking = type.thinking ?? context.thinking;
		const args = ["--session", sessionFile];
		if (model) args.push("--model", model);
		if (thinking) args.push("--thinking", thinking);
		if (type.tools) args.push("--tools", type.tools.join(","));
		if (type.systemPrompt.trim()) {
			const promptFile = join(dir, `${name}.prompt.md`);
			writeFileSync(promptFile, type.systemPrompt, { mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
		}
		args.push(...(this.options.extraArgs ?? []));

		const child = new RpcChild({
			cwd: context.cwd,
			args,
			env: { ...this.options.env, [CHILD_ENV]: "1" },
			pi: this.options.pi,
		});
		const agent = new Subagent(
			{ name, type: type.name, task: request.task, model: model ?? "", thinking, sessionFile },
			child,
			this.options.askQuestion,
		);
		agent.onChange(() => this.changed());
		this.agents.set(name, agent);
		child.start();
		this.changed();
		try {
			await agent.start(request.task);
		} catch (error) {
			await agent.stop();
			throw error;
		}
		return agent;
	}

	/** Ends an agent and forgets it. */
	async stop(name: string): Promise<void> {
		const agent = this.agents.get(name);
		if (!agent) return;
		this.agents.delete(name);
		await agent.stop();
		rmSync(join(this.options.sessionDir(), `${name}.prompt.md`), { force: true });
		this.changed();
	}

	async stopAll(): Promise<void> {
		await Promise.all(this.list().map((agent) => this.stop(agent.info.name)));
	}

	private uniqueName(base: string): string {
		if (!this.agents.has(base)) return base;
		let n = 2;
		while (this.agents.has(`${base}-${n}`)) n++;
		return `${base}-${n}`;
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}
