/**
 * Loaded into test subagents: a scripted "faux" model instead of a real one, plus an
 * extension that sends a notice and asks a question, like real extensions in a child do.
 * The behaviour comes from SCRIPT (see the cases below).
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const lastUserText = (messages: { role: string; content: unknown }[]) => {
	const user = [...messages].reverse().find((m) => m.role === "user");
	const content = user?.content;
	return typeof content === "string" ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("") : "";
};

export default function (pi: ExtensionAPI) {
	const script = process.env.SCRIPT ?? "echo";
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: script === "slow" ? 40 : undefined });
	const reply = (context: { messages: { role: string; content: unknown }[] }) => {
		const text = lastUserText(context.messages);
		if (script === "fail") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "You've hit your usage limit." });
		if (script === "tool" && !context.messages.some((m) => m.role === "toolResult")) {
			return fauxAssistantMessage(fauxToolCall("ls", { path: "." }));
		}
		if (script === "slow" && !/steer/i.test(text)) return fauxAssistantMessage("word ".repeat(100));
		return fauxAssistantMessage(`Done: ${text}`);
	};
	faux.setResponses(Array.from({ length: 20 }, () => reply));
	pi.registerProvider(faux.provider);

	pi.on("before_agent_start", async (event, ctx) => {
		if (script === "notify") ctx.ui.notify("Anthropic account 1 hit its usage limit. Continuing on account 2.", "warning");
		if (script === "ask") {
			const ok = await ctx.ui.confirm("Allow?", `Run: ${event.prompt}`);
			return { message: { customType: "answer", content: `user said ${ok ? "yes" : "no"}`, display: true } };
		}
	});
}
