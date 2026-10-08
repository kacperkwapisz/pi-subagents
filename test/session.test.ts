/**
 * pi-subagents inside a real Pi agent session (Pi's SDK): a scripted main model calls the tools,
 * and real child Pi processes do the work with a scripted model of their own.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Context, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiSubagents } from "../src/index.ts";
import type { AgentManager } from "../src/manager.ts";

const CLI = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const FIXTURE = join(import.meta.dirname, "fixtures", "scripted-child.ts");

const toolResults = (context: Context) =>
	context.messages
		.filter((m) => m.role === "toolResult")
		.map((m) => (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join(""));

async function startSession(
	script: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
	extra?: ExtensionFactory,
	childScript = "echo",
) {
	const dir = mkdtempSync(join(tmpdir(), "psa-session-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "x" } }));
	// The main conversation's model; subagents inherit "faux/faux-1" and get their own scripted copy.
	let manager: AgentManager | undefined;
	const main = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	main.setResponses(script);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		extensionFactories: [
			(pi) => pi.registerProvider(main.provider),
			createPiSubagents(
				{
					sessionDir: () => join(dir, "subagents"),
					pi: { command: process.execPath, args: [CLI] },
					extraArgs: ["--no-extensions", "-e", FIXTURE, "--no-skills", "--no-prompt-templates", "--no-context-files"],
					env: { PI_CODING_AGENT_DIR: dir, SCRIPT: childScript },
				},
				(created) => (manager = created),
			),
			...(extra ? [extra] : []),
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } }),
		model: main.getModel(),
	});
	await session.bindExtensions({});
	// What Pi's session_shutdown does on quit: end the subagents.
	const close = async () => {
		await manager?.stopAll();
		session.dispose();
	};
	return { session, close, main, manager: () => manager! };
}

test("the main model starts two agents in parallel and gets both answers", { timeout: 90_000 }, async () => {
	let seen: string[] = [];
	const { session, close } = await startSession([
		fauxAssistantMessage(
			fauxToolCall("agent_start", {
				agents: [
					{ task: "Review src/auth.ts", type: "reviewer", name: "auth-review" },
					{ task: "Find the docs for login", type: "scout" },
				],
			}),
		),
		(context) => {
			seen = toolResults(context);
			return fauxAssistantMessage("Both agents are done.");
		},
	]);
	try {
		await session.prompt("Review auth and find the docs, in parallel.");
		const answer = seen.join("\n");
		assert.match(answer, /## auth-review \(reviewer\)\nDone: Review src\/auth\.ts/);
		assert.match(answer, /## scout \(scout\)\nDone: Find the docs for login/);
	} finally {
		await close();
	}
});

test("agents started without waiting are collected with agent_wait, messaged, listed and stopped", { timeout: 90_000 }, async () => {
	const results: string[][] = [];
	const record = (next: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
		results.push(toolResults(context));
		return next;
	};
	const { session, close } = await startSession([
		fauxAssistantMessage(fauxToolCall("agent_start", { agents: [{ task: "first job", name: "helper" }], wait: false })),
		record(fauxAssistantMessage(fauxToolCall("agent_wait", { names: ["helper"] }))),
		record(fauxAssistantMessage(fauxToolCall("agent_send", { name: "helper", message: "second job" }))),
		record(fauxAssistantMessage(fauxToolCall("agent_wait", {}))),
		record(fauxAssistantMessage(fauxToolCall("agent_list", {}))),
		record(fauxAssistantMessage(fauxToolCall("agent_stop", { names: ["helper", "ghost"] }))),
		record(fauxAssistantMessage("All done.")),
	]);
	try {
		await session.prompt("Delegate.");
		const last = (i: number) => results[i]!.at(-1)!;
		assert.equal(last(0), "Started helper. Use agent_wait to get their answers.");
		assert.equal(last(1), "## helper (worker)\nDone: first job");
		assert.equal(last(2), "helper is working on it. Use agent_wait for its answer.");
		assert.equal(last(3), "## helper (worker)\nDone: second job");
		assert.match(last(4), /^helper \(worker\): idle, done; faux\/faux-1; \d+ in \/ \d+ out$/);
		assert.equal(last(5), "Stopped helper. No agent named ghost.");
	} finally {
		await close();
	}
});

test("keepOpen from the tool closes a finished agent at once", { timeout: 90_000 }, async () => {
	let list = "";
	const { session, close } = await startSession([
		fauxAssistantMessage(fauxToolCall("agent_start", { agents: [{ task: "quick job", name: "quick", keepOpen: 0 }] })),
		fauxAssistantMessage(fauxToolCall("agent_list", {})),
		(context) => {
			list = toolResults(context).at(-1) ?? "";
			return fauxAssistantMessage("ok");
		},
	]);
	try {
		await session.prompt("Run one quick agent.");
		assert.match(list, /^quick \(worker\): idle, closed, done;/);
	} finally {
		await close();
	}
});

const until = async (check: () => boolean, ms = 20_000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

test("a background agent's result starts the main agent's next turn; other extensions hear about it", { timeout: 90_000 }, async () => {
	let resultTurn = "";
	const events: unknown[] = [];
	let runningWhileWorking: string[] | undefined;
	const { session, close, main } = await startSession(
		[
			fauxAssistantMessage(fauxToolCall("agent_start", { agents: [{ task: "background job", name: "helper" }], wait: false })),
			fauxAssistantMessage("Started it; I'll pick up the result when it's ready."),
			(context) => {
				const last = context.messages.at(-1) as { role: string; content: unknown };
				resultTurn = typeof last.content === "string" ? last.content : (last.content as { text?: string }[]).map((part) => part.text ?? "").join("");
				return fauxAssistantMessage("Got the helper's result.");
			},
		],
		(pi) => {
			pi.on("tool_execution_end", () => {
				pi.events.emit("pi-subagents:query", { reply: (names: string[]) => (runningWhileWorking = names) });
			});
			pi.events.on("pi-subagents:finished", (data) => events.push(data));
		},
	);
	try {
		await session.prompt("Run a helper in the background.");
		await until(() => resultTurn !== "");
		assert.deepEqual(runningWhileWorking, ["helper"]);
		assert.match(resultTurn, /Agent helper finished in the background\./);
		assert.match(resultTurn, /## helper \(worker\)\nDone: background job/);
		assert.deepEqual(events, [{ name: "helper", status: "idle", triggersTurn: true }]);
		await until(() => main.state.callCount === 3);
	} finally {
		await close();
	}
});

test("agents someone waits for add no extra message", { timeout: 90_000 }, async () => {
	const { session, close, main } = await startSession([
		fauxAssistantMessage(fauxToolCall("agent_start", { agents: [{ task: "job" }] })),
		fauxAssistantMessage("done"),
		fauxAssistantMessage("this must not be needed"),
	]);
	try {
		await session.prompt("Run one agent and wait.");
		await new Promise((resolve) => setTimeout(resolve, 1000));
		assert.equal(main.state.callCount, 2);
	} finally {
		await close();
	}
});

const lastText = (context: { messages: unknown[] }) => {
	const last = context.messages.at(-1) as { content: unknown };
	return typeof last.content === "string" ? last.content : (last.content as { text?: string }[]).map((part) => part.text ?? "").join("");
};

test("an agent can start from a copy of the conversation, without the call that is still running", { timeout: 90_000 }, async () => {
	let answer = "";
	const { session, close } = await startSession(
		[
			fauxAssistantMessage("I fixed the bug in auth.ts."),
			fauxAssistantMessage(fauxToolCall("agent_start", { agents: [{ task: "Review the fix", name: "review", context: "conversation" }] })),
			(context) => {
				answer = toolResults(context).at(-1) ?? "";
				return fauxAssistantMessage("ok");
			},
		],
		undefined,
		"context",
	);
	try {
		await session.prompt("Fix the auth bug.");
		await session.prompt("Now get it reviewed.");
		// The two user turns, the first answer, then the task: 4 messages, no dangling tool call.
		assert.match(answer, /## review \(worker\)\nSaw 4 messages: Fix the auth bug\. \| Now get it reviewed\. \| You are a subagent started from the conversation above/);
	} finally {
		await close();
	}
});

test("a fresh agent sees only its task", { timeout: 90_000 }, async () => {
	let answer = "";
	const { session, close } = await startSession(
		[
			fauxAssistantMessage(fauxToolCall("agent_start", { agents: [{ task: "Look around", name: "fresh" }] })),
			(context) => {
				answer = toolResults(context).at(-1) ?? "";
				return fauxAssistantMessage("ok");
			},
		],
		undefined,
		"context",
	);
	try {
		await session.prompt("Start an agent.");
		assert.match(answer, /Saw 1 messages: Look around$/);
	} finally {
		await close();
	}
});

test("a long wait checks in; the agent keeps working and reports back on its own", { timeout: 90_000 }, async () => {
	let checkIn = "";
	let later = "";
	const { session, close, main } = await startSession(
		[
			fauxAssistantMessage(fauxToolCall("agent_start", { agents: [{ task: "long job", name: "slowpoke" }], checkIn: 1 })),
			(context) => {
				checkIn = toolResults(context).at(-1) ?? "";
				return fauxAssistantMessage("It's still going; I'll wait for it to report back.");
			},
			(context) => {
				later = lastText(context);
				return fauxAssistantMessage("Got it.");
			},
		],
		undefined,
		"slow",
	);
	try {
		await session.prompt("Run a long job.");
		assert.match(checkIn, /^## slowpoke \(worker\): still working, \d+s so far\nNow: /);
		assert.match(checkIn, /They keep working and report back on their own/);
		await until(() => later !== "", 30_000);
		assert.match(later, /Agent slowpoke finished in the background\.\n\n## slowpoke \(worker\)\nword word/);
		await until(() => main.state.callCount === 3);
	} finally {
		await close();
	}
});
