/**
 * A scripted model for looking at the UI in a real interactive Pi (scripts/visual-check.py).
 * In the main session it starts three agents; in each agent it behaves according to the task:
 * "list" runs a tool first, "fail" fails, anything else writes slowly.
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Message = { role: string; content: unknown };
const text = (message: Message | undefined) =>
	typeof message?.content === "string"
		? message.content
		: Array.isArray(message?.content)
			? message.content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

export default function (pi: ExtensionAPI) {
	const child = process.env.PI_SUBAGENTS_CHILD === "1";
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: child ? 25 : undefined });

	const reply = (context: { messages: Message[] }) => {
		const messages = context.messages;
		if (!child) {
			if (!messages.some((m) => m.role === "toolResult")) {
				return fauxAssistantMessage(
					fauxToolCall("agent_start", {
						agents: [
							{ task: "list the project files and summarise them", type: "scout", name: "files" },
							{ task: "review the auth module for race conditions", type: "reviewer", name: "auth-review" },
							{ task: "fail on purpose", type: "worker", name: "flaky" },
						],
					}),
				);
			}
			return fauxAssistantMessage("All three agents reported back.");
		}
		const task = text(messages.find((m) => m.role === "user"));
		if (/fail/.test(task)) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "You've hit your usage limit." });
		if (/list/.test(task) && !messages.some((m) => m.role === "toolResult")) return fauxAssistantMessage(fauxToolCall("ls", { path: "." }));
		return fauxAssistantMessage(
			"Found two places where the token refresh can race:\n\n1. `refresh()` reads the token before the lock.\n2. The retry path skips the lock entirely.\n\nBoth are fixable with one mutex around the refresh.",
		);
	};
	faux.setResponses(Array.from({ length: 50 }, () => reply));
	pi.registerProvider(faux.provider);
}
