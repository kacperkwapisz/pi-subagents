/**
 * The engine against real Pi child processes in RPC mode. Each child loads only a scripted
 * test extension (a faux model), so no account or network is involved.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentType } from "../src/agent-types.ts";
import { AgentManager } from "../src/manager.ts";

const CLI = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const FIXTURE = join(import.meta.dirname, "fixtures", "scripted-child.ts");
const types: AgentType[] = [
	{ name: "worker", description: "does work", systemPrompt: "You are a worker.", source: "bundled" },
	{ name: "scout", description: "looks around", tools: ["read", "ls"], systemPrompt: "", source: "bundled" },
];

const SUBAGENTS = join(import.meta.dirname, "..", "src", "index.ts");

function setup(script: string, answer: { confirmed?: boolean } = {}, withProgressTool = false) {
	const agentDir = mkdtempSync(join(tmpdir(), "psa-agent-"));
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "x" } }));
	const questions: string[] = [];
	const manager = new AgentManager({
		sessionDir: () => join(agentDir, "subagents", "parent-session"),
		askQuestion: async (agent, request) => {
			questions.push(`${agent.info.name}: ${request.title}`);
			return answer;
		},
		pi: { command: process.execPath, args: [CLI] },
		// With withProgressTool the child also loads pi-subagents, as a real subagent does.
		extraArgs: ["--no-extensions", "-e", FIXTURE, ...(withProgressTool ? ["-e", SUBAGENTS] : []), "--no-skills", "--no-prompt-templates", "--no-context-files"],
		env: { PI_CODING_AGENT_DIR: agentDir, SCRIPT: script },
	});
	const context = { cwd: agentDir, model: "faux/faux-1", types };
	return { manager, context, questions };
}

test("a subagent runs its task in its own Pi process and reports the answer, usage and model", { timeout: 60_000 }, async () => {
	const { manager, context } = setup("echo");
	try {
		const agent = await manager.start({ task: "Summarise the repo", name: "Repo Summary" }, context);
		assert.equal(agent.info.name, "repo-summary");
		await agent.whenSettled();
		assert.equal(agent.state, "idle");
		assert.equal(agent.result, "Done: Summarise the repo");
		assert.equal(agent.info.model, "faux/faux-1");
		assert.ok(agent.usage.output > 0, "usage is counted");
		assert.ok(existsSync(agent.info.sessionFile), "its session is kept");
		assert.deepEqual(
			agent.transcript.map((item) => item.kind),
			["prompt", "text"],
		);
	} finally {
		await manager.stopAll();
	}
});

test("an idle subagent takes more work; names stay unique", { timeout: 60_000 }, async () => {
	const { manager, context } = setup("echo");
	try {
		const first = await manager.start({ task: "one" }, context);
		const second = await manager.start({ task: "two" }, context);
		assert.deepEqual([first.info.name, second.info.name], ["worker", "worker-2"]);
		await first.whenSettled();
		await first.send("and now this");
		assert.equal(first.state, "running");
		await first.whenSettled();
		assert.equal(first.result, "Done: and now this");
	} finally {
		await manager.stopAll();
	}
});

test("a running subagent can be steered", { timeout: 60_000 }, async () => {
	const { manager, context } = setup("slow");
	try {
		const agent = await manager.start({ task: "write a long essay" }, context);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert.equal(agent.state, "running");
		assert.equal(agent.activity, "writing");
		await agent.send("steer: stop and just say hi");
		await agent.whenSettled();
		assert.equal(agent.result, "Done: steer: stop and just say hi");
		assert.ok(agent.transcript.some((item) => item.kind === "prompt" && item.via === "steer"));
	} finally {
		await manager.stopAll();
	}
});

test("tool calls show what the agent is doing and land in the transcript", { timeout: 60_000 }, async () => {
	const { manager, context } = setup("tool");
	try {
		const agent = await manager.start({ task: "look around", type: "scout" }, context);
		const activities = new Set<string>();
		agent.onChange(() => activities.add(agent.activity));
		await agent.whenSettled();
		assert.ok(activities.has("listing ."), [...activities].join(", "));
		const tool = agent.transcript.find((item) => item.kind === "tool");
		assert.equal(tool?.kind === "tool" && tool.status, "done");
		assert.ok(tool?.kind === "tool" && tool.output.includes("auth.json"), "the tool's output is kept");
	} finally {
		await manager.stopAll();
	}
});

test("a model error marks the agent failed with the reason", { timeout: 60_000 }, async () => {
	const { manager, context } = setup("fail");
	try {
		const agent = await manager.start({ task: "anything" }, context);
		await agent.whenSettled();
		assert.equal(agent.state, "failed");
		assert.match(agent.error ?? "", /usage limit/);
	} finally {
		await manager.stopAll();
	}
});

test("notices from extensions inside the subagent reach its transcript", { timeout: 60_000 }, async () => {
	const { manager, context } = setup("notify");
	try {
		const agent = await manager.start({ task: "anything" }, context);
		await agent.whenSettled();
		const notice = agent.transcript.find((item) => item.kind === "notice");
		assert.deepEqual(notice, {
			kind: "notice",
			text: "Anthropic account 1 hit its usage limit. Continuing on account 2.",
			level: "warning",
		});
	} finally {
		await manager.stopAll();
	}
});

test("questions from extensions inside the subagent are asked and answered", { timeout: 60_000 }, async () => {
	const { manager, context, questions } = setup("ask", { confirmed: true });
	try {
		const agent = await manager.start({ task: "rm -rf build" }, context);
		await agent.whenSettled();
		assert.deepEqual(questions, ["worker: Allow?"]);
		assert.equal(agent.result, "Done: user said yes");
	} finally {
		await manager.stopAll();
	}
});

test("stopping an agent ends its process; unknown types are refused", { timeout: 60_000 }, async () => {
	const { manager, context } = setup("slow");
	const agent = await manager.start({ task: "long" }, context);
	await manager.stop(agent.info.name);
	assert.equal(agent.state, "stopped");
	assert.equal(manager.list().length, 0);
	await assert.rejects(manager.start({ task: "x", type: "wizard" }, context), /Unknown agent type "wizard". Available: worker, scout/);
});

test("an agent reports its progress in its own words, even when its tools are limited", { timeout: 60_000 }, async () => {
	const { manager, context } = setup("progress", {}, true);
	try {
		const agent = await manager.start({ task: "review auth", type: "scout" }, context);
		await agent.whenSettled();
		assert.equal(agent.state, "idle", agent.error);
		assert.equal(agent.status, "Reading the auth module");
		assert.ok(agent.transcript.some((item) => item.kind === "status" && item.text === "Reading the auth module"));
	} finally {
		await manager.stopAll();
	}
});

test("the thinking level can be chosen per agent, and unknown levels are refused", { timeout: 60_000 }, async () => {
	const { manager, context } = setup("echo");
	try {
		const agent = await manager.start({ task: "think hard", thinking: "high" }, { ...context, thinking: "low" });
		const inherited = await manager.start({ task: "default" }, { ...context, thinking: "low" });
		await Promise.all([agent.whenSettled(), inherited.whenSettled()]);
		assert.equal(agent.info.thinking, "high", "the level the child really runs at");
		assert.equal(inherited.info.thinking, "low");
		await assert.rejects(manager.start({ task: "x", thinking: "extreme" }, context), /Unknown thinking level "extreme"/);
	} finally {
		await manager.stopAll();
	}
});
