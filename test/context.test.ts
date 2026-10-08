import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { conversationSnapshot, writeConversation } from "../src/context.ts";

const at = "2026-01-01T00:00:00.000Z";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: unknown[]) => ({ role: "assistant", content, api: "x", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 1 });
const entry = (id: string, message: unknown) => ({ type: "message", id, parentId: null, timestamp: at, message });

test("the snapshot keeps the conversation but drops the system prompt, unanswered tool calls and stray results", () => {
	const entries = [
		entry("s", { role: "system", content: "You are the main agent.", timestamp: 1 }),
		{ type: "compaction", id: "c", parentId: null, timestamp: at, summary: "We set up the repo.", firstKeptEntryId: "1", tokensBefore: 5000 },
		entry("1", { role: "user", content: [{ type: "text", text: "Fix auth" }], timestamp: 1 }),
		entry("2", assistant([{ type: "text", text: "Reading" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }])),
		entry("3", { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "code" }], isError: false, timestamp: 1 }),
		entry("4", { role: "toolResult", toolCallId: "ghost", toolName: "read", content: [], isError: false, timestamp: 1 }),
		entry("5", assistant([{ type: "thinking", thinking: "delegate" }, { type: "toolCall", id: "running", name: "agent_start", arguments: {} }])),
	];
	const messages = conversationSnapshot({ buildContextEntries: () => entries as never });
	assert.deepEqual(
		messages.map((message) => message.role),
		["custom", "user", "assistant", "toolResult"],
	);
	assert.match(String((messages[0] as { content: string }).content), /Summary of earlier conversation:\n\nWe set up the repo\./);
	assert.equal((messages[2] as { content: unknown[] }).content.length, 2, "the answered call stays");
});

test("the snapshot is written into the agent's session file and reads back the same", () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-context-"));
	const file = join(dir, "agent.jsonl");
	writeFileSync(file, "", { mode: 0o600 });
	const messages = conversationSnapshot({
		buildContextEntries: () =>
			[entry("1", { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }), entry("2", assistant([{ type: "text", text: "hi" }]))] as never,
	});
	writeConversation(file, dir, messages);
	const read = SessionManager.open(file, undefined, dir).buildSessionContext().messages;
	assert.deepEqual(read.map((message) => message.role), ["user", "assistant"]);
});
