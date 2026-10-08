import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Subagent } from "./agent.ts";
import { AgentManager, CHILD_ENV, type ManagerOptions } from "./manager.ts";
import type { UiRequest } from "./rpc.ts";
import { registerTools } from "./tools.ts";

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
		// Inside a subagent this extension stays out of the way: no nested agents yet.
		if (process.env[CHILD_ENV]) return;

		let current: ExtensionContext | undefined;
		const manager = new AgentManager({
			sessionDir: () => join(getAgentDir(), "subagents", current?.sessionManager.getSessionId() ?? "session"),
			askQuestion: (agent, request) => askInParent(current, agent, request),
			...overrides,
		});
		onManager?.(manager);

		pi.on("session_start", (_event, ctx) => {
			current = ctx;
		});
		pi.on("session_shutdown", async () => {
			await manager.stopAll();
			current = undefined;
		});

		registerTools(pi, manager);
	};
}

export default createPiSubagents();
