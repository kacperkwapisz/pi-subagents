import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { Subagent } from "./agent.ts";
import { AgentManager, CHILD_ENV, type ManagerOptions } from "./manager.ts";
import type { UiRequest } from "./rpc.ts";
import { registerProgressTool } from "./progress.ts";
import { Questions } from "./questions.ts";
import { annotateFailures } from "./status.ts";
import { answerOf, registerTools } from "./tools.ts";
import { safely } from "./ui/safe.ts";
import { type AgentSnapshot, renderAgentsResult, snapshot } from "./ui/tool-render.ts";
import { AgentsBrowser } from "./ui/browser.ts";
import { AgentsWidget } from "./ui/widget.ts";

/** Asks the user a question that an extension inside a subagent asked. */
async function askInParent(
	ctx: ExtensionContext | undefined,
	agent: Subagent,
	request: UiRequest,
): Promise<{ value?: string; confirmed?: boolean; cancelled?: boolean }> {
	if (!ctx?.hasUI) return { cancelled: true };
	const title = `${agent.info.name}: ${String(request.title ?? "")}`;
	switch (request.method) {
		case "select": {
			const value = await ctx.ui.select(title, (request.options as string[] | undefined) ?? []);
			return value === undefined ? { cancelled: true } : { value };
		}
		case "confirm":
			return { confirmed: await ctx.ui.confirm(title, String(request.message ?? "")) };
		case "input": {
			const value = await ctx.ui.input(title, request.placeholder as string | undefined);
			return value === undefined ? { cancelled: true } : { value };
		}
		case "editor": {
			const value = await ctx.ui.editor(title, request.prefill as string | undefined);
			return value === undefined ? { cancelled: true } : { value };
		}
		default:
			return { cancelled: true };
	}
}

/**
 * Builds the extension. Tests pass which Pi to run for subagents and where to keep them, and
 * receive the manager to stop agents when done.
 */
export function createPiSubagents(overrides: Partial<ManagerOptions> = {}, onManager?: (manager: AgentManager) => void) {
	return function piSubagents(pi: ExtensionAPI) {
		// Inside a subagent: only the tool for reporting progress (no nested agents yet).
		if (process.env[CHILD_ENV]) {
			registerProgressTool(pi);
			return;
		}

		let current: ExtensionContext | undefined;
		const questions = new Questions((agent, request) => askInParent(current, agent, request));
		const manager = new AgentManager({
			sessionDir: () => join(getAgentDir(), "subagents", current?.sessionManager.getSessionId() ?? "session"),
			askQuestion: (agent, request) => questions.ask(agent, request),
			...overrides,
		});
		onManager?.(manager);
		const widget = new AgentsWidget(
			manager,
			() => current,
			(name) => {
				if (current) void openBrowser(current, name);
			},
		);

		pi.events.on(QUERY_EVENT, (data) => {
			const reply = (data as { reply?: unknown } | undefined)?.reply;
			if (typeof reply === "function") reply(manager.list().filter((agent) => agent.busy).map((agent) => agent.info.name));
		});

		// A background agent (started without waiting) finished: tell the user and the main agent,
		// which starts its next turn with the result. A wait in progress reports the result itself.
		manager.onFinish((agent, { detached, stoppedByUser, interrupted }) => {
			if (!detached) return;
			const name = agent.info.name;
			// The user interrupted it (or the wait for it): they are in control, so no new turn
			// and nothing in the chat; other extensions still hear that it stopped working.
			if (interrupted) {
				pi.events.emit(FINISHED_EVENT, { name, status: "interrupted", triggersTurn: false });
				return;
			}
			const ok = agent.state === "idle";
			if (current?.hasUI) {
				const what = stoppedByUser ? "stopped" : ok ? "done" : agent.state;
				current.ui.notify(`Agent ${name} ${what}`, ok || stoppedByUser ? "info" : "error");
			}
			pi.events.emit(FINISHED_EVENT, { name, status: agent.state, triggersTurn: !stoppedByUser });
			void report(agent, stoppedByUser);
		});
		const report = async (agent: Subagent, stoppedByUser: boolean) => {
			const name = agent.info.name;
			await annotateFailures(pi.events, [agent]);
			const content = stoppedByUser
				? `The user stopped agent ${name} before it finished.`
				: `Agent ${name} finished in the background.\n\n${answerOf(agent)}`;
			void pi.sendMessage(
				{ customType: RESULT_MESSAGE, content, display: true, details: snapshot(agent) },
				stoppedByUser ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "followUp" },
			);
		};

		pi.registerMessageRenderer<AgentSnapshot>(RESULT_MESSAGE, (message, { expanded }, theme) =>
			safely(() =>
				renderAgentsResult(
					message.details ? { agents: [message.details] } : undefined,
					typeof message.content === "string" ? message.content : "",
					{ expanded, isPartial: false },
					theme,
				),
			),
		);

		let browserOpen = false;
		const openBrowser = async (ctx: ExtensionContext, initial?: string) => {
			if (browserOpen || ctx.mode !== "tui") return;
			browserOpen = true;
			questions.setInline(true);
			try {
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) =>
						new AgentsBrowser({ manager, questions, theme, tui, keybindings, initial, close: () => done() }),
					// Full screen, so nothing from the chat shows through around it.
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 } },
				);
			} finally {
				browserOpen = false;
				questions.setInline(false);
			}
		};

		pi.registerCommand("agents", {
			description: "Watch and steer your subagents",
			handler: async (args, ctx) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("/agents needs the interactive terminal.", "warning");
					return;
				}
				await openBrowser(ctx, args.trim() || undefined);
			},
		});

		let stopListening: (() => void) | undefined;
		pi.on("session_start", (_event, ctx) => {
			current = ctx;
			widget.update();
			if (ctx.mode !== "tui") return;
			// ← in an empty editor opens the browser while there are agents; otherwise ← is untouched.
			stopListening?.();
			stopListening = ctx.ui.onTerminalInput((data) => {
				if (!matchesKey(data, Key.left) || browserOpen || manager.list().length === 0) return undefined;
				if (ctx.ui.getEditorText() !== "") return undefined;
				void openBrowser(ctx);
				return { consume: true };
			});
		});
		// A new message from the user: finished agents leave the widget, and closed ones are
		// forgotten entirely so nothing builds up over a long session.
		pi.on("before_agent_start", () => {
			widget.hideSettled();
			manager.forgetClosed();
		});
		pi.on("session_shutdown", async () => {
			stopListening?.();
			stopListening = undefined;
			widget.dispose();
			await manager.stopAll();
			current = undefined;
		});

		registerTools(pi, manager);
	};
}

/** Chat messages that bring a background agent's result to the main agent. */
const RESULT_MESSAGE = "pi-subagents-result";

/**
 * For other extensions (such as a goal loop's wait), over pi.events, in the same shape as
 * bg-jobs: emit `pi-subagents:query` with `{ reply(names) }` to learn which agents are working;
 * listen to `pi-subagents:finished` for `{ name, status, triggersTurn }`.
 */
export const QUERY_EVENT = "pi-subagents:query";
export const FINISHED_EVENT = "pi-subagents:finished";

export default createPiSubagents();
