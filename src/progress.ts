import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The tool a subagent uses to say what it is working on. */
export const PROGRESS_TOOL = "report_progress";
/** The status key it reports under (Pi's RPC `setStatus`), which the parent listens for. */
export const PROGRESS_KEY = "pi-subagents";
const MAX_LENGTH = 80;

/**
 * Inside a subagent: lets the agent tell the user what it is doing, in its own words. Pi
 * forwards the status to the parent process, where it becomes the agent's main status line.
 */
export function registerProgressTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: PROGRESS_TOOL,
		label: "Report progress",
		description:
			"Tell the user what you are working on right now, in a few plain words (under 60 characters). " +
			"It is shown live next to your name; it does not end your turn or send a message.",
		promptSnippet: `${PROGRESS_TOOL}: show the user what you are working on`,
		promptGuidelines: [
			`Call ${PROGRESS_TOOL} when you start, whenever you move on to a new step, and before anything slow, e.g. "Reading the auth module" or "Found 2 races; checking the tests".`,
			"Describe the step, not the tool: say what you are finding out or doing, not which file command you run.",
		],
		parameters: Type.Object({
			status: Type.String({ description: "What you are doing now, e.g. Reviewing the refresh flow" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const status = params.status.replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
			ctx.ui.setStatus(PROGRESS_KEY, status || undefined);
			return { content: [{ type: "text", text: "Shown to the user. Carry on." }], details: {} };
		},
	});
}
