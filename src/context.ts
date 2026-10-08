import { type ExtensionContext, SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

type Message = ReturnType<typeof sessionEntryToContextMessages>[number];
type Part = { type: string; id?: string };

/** Marks the copied conversation for the subagent. */
export const CONTEXT_TYPE = "pi-subagents-context";

/**
 * The main conversation as the model sees it now, made safe to continue from in another
 * session: tool calls without a result (such as the agent_start call that is running right
 * now) and results without a call are dropped, and summaries become plain notes. The main
 * agent's system prompt (Pi keeps it as `system` messages) is left out: the subagent has its own.
 */
export function conversationSnapshot(session: Pick<ExtensionContext["sessionManager"], "buildContextEntries">): Message[] {
	const messages = session.buildContextEntries().flatMap((entry) => sessionEntryToContextMessages(entry));
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") for (const part of message.content as Part[]) if (part.type === "toolCall" && part.id) calls.add(part.id);
		if (message.role === "toolResult") results.add(message.toolCallId);
	}
	const out: Message[] = [];
	for (const message of messages) {
		if ((message.role as string) === "system") continue;
		if (message.role === "assistant") {
			const content = (message.content as Part[]).filter((part) => part.type !== "toolCall" || (part.id && results.has(part.id)));
			// Left with only thinking (its tool call was the running one): nothing to carry over.
			if (content.some((part) => part.type !== "thinking")) out.push({ ...message, content } as Message);
		} else if (message.role === "toolResult") {
			if (calls.has(message.toolCallId)) out.push(message);
		} else if (message.role === "compactionSummary" || message.role === "branchSummary") {
			out.push(note(`Summary of earlier conversation:\n\n${message.summary}`, message.timestamp));
		} else if (message.role === "bashExecution") {
			if (!message.excludeFromContext) out.push(message);
		} else {
			out.push(message);
		}
	}
	return out;
}

function note(text: string, timestamp: number): Message {
	return { role: "custom", customType: CONTEXT_TYPE, content: text, display: false, timestamp } as Message;
}

/** Writes the messages into a new subagent's (empty) session file. */
export function writeConversation(sessionFile: string, cwd: string, messages: Message[]): void {
	if (messages.length === 0) return;
	const session = SessionManager.open(sessionFile, undefined, cwd);
	for (const message of messages) session.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
}

/** Put before the task when the agent starts from the conversation. */
export const FROM_CONVERSATION =
	"You are a subagent started from the conversation above, which belongs to the main agent. " +
	"Do only the task below, then reply with your result for the main agent.\n\nTask:\n";
