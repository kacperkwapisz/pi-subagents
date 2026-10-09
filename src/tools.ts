import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Subagent } from "./agent.ts";
import { discoverAgentTypes } from "./agent-types.ts";
import { conversationSnapshot } from "./context.ts";
import { annotateFailures, statusFor } from "./status.ts";
import { type AgentManager, DEFAULT_KEEP_OPEN_MS, MAX_AGENTS, MAX_KEEP_OPEN_MS, THINKING_LEVELS } from "./manager.ts";
import { formatDuration } from "./ui/format.ts";
import { safely } from "./ui/safe.ts";
import { type AgentsDetails, renderAgentsResult, renderStartCall, renderWaitCall, snapshot } from "./ui/tool-render.ts";

/** Each agent's answer is capped before it goes back to the main model. */
const ANSWER_LIMIT = 50_000;

export function answerOf(agent: Subagent): string {
	const header = `## ${agent.info.name} (${agent.info.type})`;
	if (agent.state === "failed") {
		const status = agent.providerStatus ? `\nProvider status: ${agent.providerStatus}` : "";
		return `${header}: failed\n${agent.error ?? "Unknown error."}${status}`;
	}
	if (agent.state === "stopped") return `${header}: stopped`;
	if (agent.busy) return `${header}: still running (${agent.activity || "working"})`;
	const answer = agent.result?.trim() || "(no answer)";
	const clipped = answer.length > ANSWER_LIMIT ? `${answer.slice(0, ANSWER_LIMIT)}\n[answer cut at ${ANSWER_LIMIT} characters]` : answer;
	return `${header}\n${clipped}`;
}

function text(value: string, agents: Subagent[] = []) {
	const details: AgentsDetails = { agents: agents.map(snapshot) };
	return { content: [{ type: "text" as const, text: value }], details };
}

/** For a running agent at check-in time: how far it got, so the main model can decide what to do. */
export function checkInOf(agent: Subagent): string {
	const lines = [`## ${agent.info.name} (${agent.info.type}): still working, ${formatDuration(agent.elapsedMs)} so far`];
	if (agent.status) lines.push(`Says: ${agent.status}`);
	if (agent.step()) lines.push(`Now: ${agent.step()}`);
	const latest = agent.transcript.findLast((item) => item.kind === "text" && item.text.trim());
	if (latest && latest.kind === "text") {
		const tail = latest.text.trim();
		lines.push(`Latest output: ${tail.length > CHECK_IN_OUTPUT ? `…${tail.slice(-CHECK_IN_OUTPUT)}` : tail}`);
	}
	return lines.join("\n");
}

const CHECK_IN_OUTPUT = 600;
const PROGRESS_MS = 250;
export const DEFAULT_CHECK_IN_S = 300;
const MAX_CHECK_IN_S = 3600;
const STILL_WORKING =
	"They keep working and report back on their own when they finish. Use agent_wait to wait longer, agent_send to steer them, or agent_stop to stop them.";

function workingMessage(agents: Subagent[]): string {
	const busy = agents.filter((agent) => agent.busy).map((agent) => agent.info.name);
	if (busy.length === 0) return "Collecting answers";
	return busy.length <= 3 ? `Waiting for ${busy.join(", ")}` : `Waiting for ${busy.length} agents`;
}

/**
 * Waits for agents to finish while showing their progress in the tool's output, up to the
 * check-in time. Esc interrupts their current runs but keeps the agents. Agents still running
 * at check-in keep going; the wait just stops, and they report back on their own later.
 */
async function waitFor(
	agents: Subagent[],
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AgentsDetails> | undefined,
	ctx: ExtensionContext | undefined,
	checkInSeconds = DEFAULT_CHECK_IN_S,
): Promise<void> {
	const stopWaiting = new AbortController();
	const working = ctx?.hasUI ? (message?: string) => ctx.ui.setWorkingMessage(message) : () => {};
	const progress = () => {
		working(workingMessage(agents));
		onUpdate?.({ content: [{ type: "text", text: "Agents working…" }], details: { agents: agents.map(snapshot) } });
	};
	const onAbort = () => {
		stopWaiting.abort();
		void Promise.all(agents.map((agent) => agent.abort().catch(() => {})));
	};
	if (signal?.aborted) onAbort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const checkIn = setTimeout(() => stopWaiting.abort(), Math.min(MAX_CHECK_IN_S, Math.max(1, checkInSeconds)) * 1000);
	progress();
	const timer = setInterval(progress, PROGRESS_MS);
	try {
		await Promise.all(agents.map((agent) => agent.whenSettled(stopWaiting.signal)));
	} finally {
		clearInterval(timer);
		clearTimeout(checkIn);
		signal?.removeEventListener("abort", onAbort);
		working();
	}
}

/** Answers for finished agents, check-ins for running ones. */
function report(agents: Subagent[], extra: string[] = []): string {
	const parts = [...extra, ...agents.map((agent) => (agent.busy ? checkInOf(agent) : answerOf(agent)))];
	if (agents.some((agent) => agent.busy)) parts.push(STILL_WORKING);
	return parts.join("\n\n");
}

const checkInParameter = Type.Optional(
	Type.Number({
		minimum: 1,
		maximum: MAX_CHECK_IN_S,
		description: `Seconds to wait before checking in (default ${DEFAULT_CHECK_IN_S}). Agents still running then keep working; you get how far they got.`,
	}),
);

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function parentModel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export function registerTools(pi: ExtensionAPI, manager: AgentManager): void {
	const types = discoverAgentTypes(process.cwd(), false);
	const typeList = types.map((type) => `${type.name} (${type.description})`).join("; ");

	pi.registerTool({
		name: "agent_start",
		label: "Start agents",
		description:
			`Start subagents. Each works on its own task in a separate Pi process with a fresh context and returns only its final answer. ` +
			`Agent types: ${typeList}. Up to ${MAX_AGENTS} open at once. ` +
			`Agents are one-off: each closes ${DEFAULT_KEEP_OPEN_MS / 1000}s after it finishes unless given more work, so plan the whole job into the task. ` +
			`By default this waits and returns their answers; with wait: false it returns right away so you can keep working, then use agent_wait.`,
		promptSnippet: "agent_start: delegate tasks to subagents that run in parallel with their own context",
		promptGuidelines: [
			"Give each agent a complete, self-contained task: it has not seen this conversation, unless you start it with context: conversation.",
			"Use context: conversation only when the task depends on what was said or done here (for example reviewing changes you just made); it costs more tokens.",
			"Start independent tasks together in one agent_start call so they run in parallel.",
			"Set thinking to match the task: low or minimal for lookups and simple edits, medium for ordinary work, high or xhigh for hard reviews, debugging and design. Leave it out to use yours.",
			"Agents close by themselves shortly after finishing. Only set keepOpen when you will send follow-ups, and agent_stop agents you no longer need instead of leaving them open.",
		],
		parameters: Type.Object({
			agents: Type.Array(
				Type.Object({
					task: Type.String({ description: "Everything the agent needs to know to do the job." }),
					type: Type.Optional(Type.String({ description: "Agent type; worker when omitted." })),
					name: Type.Optional(Type.String({ description: "Short name shown to the user, e.g. auth-review." })),
					model: Type.Optional(Type.String({ description: "provider/model, only to use a different model than yours." })),
					keepOpen: Type.Optional(
						Type.Number({
							minimum: 0,
							maximum: MAX_KEEP_OPEN_MS / 1000,
							description: `Seconds to stay open after finishing, for follow-ups with agent_send (default ${DEFAULT_KEEP_OPEN_MS / 1000}; 0 closes it right away).`,
						}),
					),
					context: Type.Optional(
						StringEnum(["fresh", "conversation"] as const, {
							description: "fresh (default): starts with only the task. conversation: starts with a copy of this conversation.",
						}),
					),
					thinking: Type.Optional(
						StringEnum(THINKING_LEVELS, { description: "How much the agent thinks; yours when omitted. Lowered automatically if the model can't do it." }),
					),
				}),
				{ minItems: 1, maxItems: MAX_AGENTS },
			),
			wait: Type.Optional(Type.Boolean({ description: "Wait for their answers (default true)." })),
			checkIn: checkInParameter,
		}),
		renderCall(args, theme) {
			return safely(() => renderStartCall(args, theme));
		},
		renderResult(result, options, theme) {
			return safely(() => renderAgentsResult(result.details as AgentsDetails | undefined, resultText(result), options, theme));
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			const context = {
				cwd: ctx.cwd,
				model: parentModel(ctx),
				thinking: ctx.thinkingLevel,
				types: discoverAgentTypes(ctx.cwd, ctx.isProjectTrusted()),
				conversation: () => conversationSnapshot(ctx.sessionManager),
			};
			const results = await Promise.allSettled(
				params.agents.map(({ keepOpen, ...request }) =>
					manager.start({ ...request, keepOpenMs: keepOpen === undefined ? undefined : keepOpen * 1000 }, context),
				),
			);
			const started = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
			let problems = results.flatMap((result) => (result.status === "rejected" ? [`Could not start: ${(result.reason as Error).message}`] : []));
			if (problems.length > 0) {
				// Say whether the provider is having trouble, for the model and the user alike.
				const models = [...new Set(params.agents.map((request) => request.model ?? context.model))];
				const statuses = (await Promise.all(models.map((model) => statusFor(pi.events, model)))).filter(Boolean);
				problems = [...problems, ...statuses.map((status) => `Provider status: ${status}`)];
			}
			if (params.wait === false) {
				const names = started.map((agent) => agent.info.name).join(", ");
				return text([started.length ? `Started ${names}. Use agent_wait to get their answers.` : "", ...problems].filter(Boolean).join("\n"), started);
			}
			await waitFor(started, signal, onUpdate, ctx, params.checkIn);
			await annotateFailures(pi.events, started);
			return text(report(started, problems), started);
		},
	});

	pi.registerTool({
		name: "agent_wait",
		label: "Wait for agents",
		description: "Wait for subagents to finish and return their answers. Without names, waits for every agent that is still running.",
		parameters: Type.Object({
			names: Type.Optional(Type.Array(Type.String(), { description: "Agents to wait for." })),
			checkIn: checkInParameter,
		}),
		renderCall(args, theme) {
			return safely(() => renderWaitCall(args, theme));
		},
		renderResult(result, options, theme) {
			return safely(() => renderAgentsResult(result.details as AgentsDetails | undefined, resultText(result), options, theme));
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			const agents = params.names?.length
				? params.names.map((name) => manager.get(name)).filter((agent): agent is Subagent => !!agent)
				: manager.list().filter((agent) => agent.busy);
			const missing = (params.names ?? []).filter((name) => !manager.get(name));
			if (agents.length === 0) return text(missing.length ? `No agent named ${missing.join(", ")}.` : "No agents are running.");
			await waitFor(agents, signal, onUpdate, ctx, params.checkIn);
			await annotateFailures(pi.events, agents);
			return text(report(agents, missing.map((name) => `No agent named ${name}.`)), agents);
		},
	});

	pi.registerTool({
		name: "agent_send",
		label: "Message an agent",
		description:
			"Send a subagent more input. A running agent gets it as steering right away (or after its current work with followUp: true); " +
			"an idle one starts working on it. Then use agent_wait for the answer.",
		parameters: Type.Object({
			name: Type.String(),
			message: Type.String(),
			followUp: Type.Optional(Type.Boolean({ description: "Queue until its current work is done instead of steering now." })),
		}),
		async execute(_id, params) {
			const agent = manager.get(params.name);
			if (!agent) return text(`No agent named ${params.name}.`);
			const wasBusy = agent.busy;
			try {
				await agent.send(params.message, params.followUp ?? false);
			} catch (error) {
				return text((error as Error).message);
			}
			return text(
				wasBusy
					? `${params.followUp ? "Queued for" : "Sent to"} ${agent.info.name}. Use agent_wait for its answer.`
					: `${agent.info.name} is working on it. Use agent_wait for its answer.`,
			);
		},
	});

	pi.registerTool({
		name: "agent_list",
		label: "List agents",
		description: "List subagents with what each is doing, its model and its token use.",
		parameters: Type.Object({}),
		async execute() {
			const agents = manager.list();
			if (agents.length === 0) return text("No agents.");
			return text(
				agents
					.map((agent) => {
						const tokens = `${agent.usage.input} in / ${agent.usage.output} out`;
						const step = agent.activity || "working";
						const work = agent.status ? `${agent.status} (${step})` : step;
						const thinking = agent.info.thinking && agent.info.thinking !== "off" ? `, thinking ${agent.info.thinking}` : "";
						const state = agent.closed && agent.state !== "stopped" ? `${agent.state}, closed` : agent.state;
						return `${agent.info.name} (${agent.info.type}): ${state}, ${work}; ${agent.info.model}${thinking}; ${tokens}`;
					})
					.join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "agent_stop",
		label: "Stop agents",
		description: "End subagents and their processes. Use when their work is done.",
		parameters: Type.Object({
			names: Type.Array(Type.String(), { minItems: 1 }),
		}),
		async execute(_id, params) {
			const known = params.names.filter((name) => manager.get(name));
			await Promise.all(known.map((name) => manager.stop(name)));
			const unknown = params.names.filter((name) => !known.includes(name));
			return text([known.length ? `Stopped ${known.join(", ")}.` : "", unknown.length ? `No agent named ${unknown.join(", ")}.` : ""].filter(Boolean).join(" "));
		},
	});
}
