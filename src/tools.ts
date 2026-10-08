import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Subagent } from "./agent.ts";
import { discoverAgentTypes } from "./agent-types.ts";
import { type AgentManager, DEFAULT_KEEP_OPEN_MS, MAX_AGENTS, MAX_KEEP_OPEN_MS, THINKING_LEVELS } from "./manager.ts";
import { safely } from "./ui/safe.ts";
import { type AgentsDetails, renderAgentsResult, renderStartCall, renderWaitCall, snapshot } from "./ui/tool-render.ts";

/** Each agent's answer is capped before it goes back to the main model. */
const ANSWER_LIMIT = 50_000;

export function answerOf(agent: Subagent): string {
	const header = `## ${agent.info.name} (${agent.info.type})`;
	if (agent.state === "failed") return `${header}: failed\n${agent.error ?? "Unknown error."}`;
	if (agent.state === "stopped") return `${header}: stopped`;
	if (agent.busy) return `${header}: still running (${agent.activity})`;
	const answer = agent.result?.trim() || "(no answer)";
	const clipped = answer.length > ANSWER_LIMIT ? `${answer.slice(0, ANSWER_LIMIT)}\n[answer cut at ${ANSWER_LIMIT} characters]` : answer;
	return `${header}\n${clipped}`;
}

function text(value: string, agents: Subagent[] = []) {
	const details: AgentsDetails = { agents: agents.map(snapshot) };
	return { content: [{ type: "text" as const, text: value }], details };
}

const PROGRESS_MS = 250;

/**
 * Waits for agents to finish while showing their progress in the tool's output. Esc
 * interrupts their current runs but keeps the agents.
 */
async function waitFor(
	agents: Subagent[],
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AgentsDetails> | undefined,
): Promise<void> {
	const progress = () => onUpdate?.({ content: [{ type: "text", text: "Agents working…" }], details: { agents: agents.map(snapshot) } });
	const onAbort = () => void Promise.all(agents.map((agent) => agent.abort().catch(() => {})));
	signal?.addEventListener("abort", onAbort, { once: true });
	progress();
	const timer = setInterval(progress, PROGRESS_MS);
	try {
		await Promise.all(agents.map((agent) => agent.whenSettled(signal)));
	} finally {
		clearInterval(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

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
			"Give each agent a complete, self-contained task: it has not seen this conversation.",
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
					thinking: Type.Optional(
						StringEnum(THINKING_LEVELS, { description: "How much the agent thinks; yours when omitted. Lowered automatically if the model can't do it." }),
					),
				}),
				{ minItems: 1, maxItems: MAX_AGENTS },
			),
			wait: Type.Optional(Type.Boolean({ description: "Wait for their answers (default true)." })),
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
			};
			const results = await Promise.allSettled(
				params.agents.map(({ keepOpen, ...request }) =>
					manager.start({ ...request, keepOpenMs: keepOpen === undefined ? undefined : keepOpen * 1000 }, context),
				),
			);
			const started = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
			const problems = results.flatMap((result) => (result.status === "rejected" ? [`Could not start: ${(result.reason as Error).message}`] : []));
			if (params.wait === false) {
				const names = started.map((agent) => agent.info.name).join(", ");
				return text([started.length ? `Started ${names}. Use agent_wait to get their answers.` : "", ...problems].filter(Boolean).join("\n"), started);
			}
			await waitFor(started, signal, onUpdate);
			return text([...problems, ...started.map(answerOf)].join("\n\n"), started);
		},
	});

	pi.registerTool({
		name: "agent_wait",
		label: "Wait for agents",
		description: "Wait for subagents to finish and return their answers. Without names, waits for every agent that is still running.",
		parameters: Type.Object({
			names: Type.Optional(Type.Array(Type.String(), { description: "Agents to wait for." })),
		}),
		renderCall(args, theme) {
			return safely(() => renderWaitCall(args, theme));
		},
		renderResult(result, options, theme) {
			return safely(() => renderAgentsResult(result.details as AgentsDetails | undefined, resultText(result), options, theme));
		},
		async execute(_id, params, signal, onUpdate) {
			const agents = params.names?.length
				? params.names.map((name) => manager.get(name)).filter((agent): agent is Subagent => !!agent)
				: manager.list().filter((agent) => agent.busy);
			const missing = (params.names ?? []).filter((name) => !manager.get(name));
			if (agents.length === 0) return text(missing.length ? `No agent named ${missing.join(", ")}.` : "No agents are running.");
			await waitFor(agents, signal, onUpdate);
			return text([...missing.map((name) => `No agent named ${name}.`), ...agents.map(answerOf)].join("\n\n"), agents);
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
						const work = agent.status ? `${agent.status} (${agent.activity})` : agent.activity;
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
