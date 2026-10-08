import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Subagent } from "../src/agent.ts";
import { formatCost, formatDuration, formatModel, formatTokens } from "../src/ui/format.ts";
import { safely } from "../src/ui/safe.ts";
import { type AgentSnapshot, renderAgentsResult, renderStartCall, renderWaitCall } from "../src/ui/tool-render.ts";
import { renderAgentsWidget } from "../src/ui/widget.ts";

initTheme("dark"); // Pi does this at startup; keyHint and Markdown need it
const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

function agent(name: string, type: string, state: Subagent["state"], activity: string, extra: Partial<Subagent> = {}): Subagent {
	return {
		info: { name, type, task: `task of ${name}`, model: "anthropic-account-3/claude-opus-5", sessionFile: "" },
		state,
		activity,
		usage: { input: 31_200, output: 2_900, cost: 0.11 },
		elapsedMs: 192_000,
		busy: state === "running" || state === "starting",
		step: () => activity,
		...extra,
	} as Subagent;
}

test("numbers, times and models read compactly", () => {
	assert.equal(formatDuration(48_000), "48s");
	assert.equal(formatDuration(192_000), "3m12s");
	assert.equal(formatDuration(3_840_000), "1h04m");
	assert.equal(formatTokens(800), "800");
	assert.equal(formatTokens(2_900), "2.9k");
	assert.equal(formatTokens(31_200), "31k");
	assert.equal(formatTokens(1_400_000), "1.4M");
	assert.equal(formatCost(0), "");
	assert.equal(formatCost(0.004), "<$0.01");
	assert.equal(formatCost(0.114), "$0.11");
	assert.equal(formatModel("anthropic-account-3/claude-opus-5"), "claude-opus-5 · account 3");
	assert.equal(formatModel("anthropic/claude-opus-5"), "claude-opus-5");
	assert.equal(formatModel("anthropic-account-3/claude-opus-5", "high"), "claude-opus-5 · account 3 · high");
	assert.equal(formatModel("anthropic/claude-opus-5", "off"), "claude-opus-5");
});

test("the widget lists agents as a tree with activity, model, time, tokens and cost", () => {
	const agents = [
		agent("fix-auth", "worker", "running", "$ npm test"),
		agent("review", "reviewer", "running", "reading src/auth.ts"),
		agent("docs", "scout", "idle", "done"),
		agent("bench", "worker", "failed", "failed", { error: "You've hit your usage limit.\nmore" }),
	];
	const width = 120;
	const lines = renderAgentsWidget(agents, theme, width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	assert.match(lines[0]!, /^Agents +2 running · 1 done · 1 failed$/);
	assert.match(lines[1]!, /^├─ ⠋ {2}worker {2}fix-auth {2}\$ npm test +claude-opus-5 · account 3 {2}3m12s {2}↑31k ↓2\.9k {2}\$0\.11$/);
	assert.match(lines[3]!, /^├─ ✓ {2}scout {2}docs {2}done /);
	assert.match(lines[4]!, /^└─ ✗ {2}worker {2}bench {2}failed: You've hit your usage limit\. /);
	assert.doesNotMatch(renderAgentsWidget(agents, theme, 80).join("\n"), /account 3/, "narrow terminals drop the model first");
	assert.deepEqual(renderAgentsWidget([], theme, 80), []);
});

const snapshot = (name: string, state: AgentSnapshot["state"], answer?: string, error?: string): AgentSnapshot => ({
	name,
	type: "reviewer",
	task: `Review ${name}`,
	state,
	activity: state === "running" ? "reading src/a.ts" : "done",
	elapsedMs: 48_000,
	usage: { input: 12_400, output: 800, cost: 0.04 },
	model: "anthropic/claude-opus-5",
	answer,
	error,
});

test("while waiting, the tool shows one line (the widget has the details)", () => {
	const one = renderAgentsResult({ agents: [snapshot("auth", "running")] }, "", { expanded: false, isPartial: true }, theme);
	assert.match(one.render(100).join("\n").trim(), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Waiting for auth · 48s$/);
	const some = renderAgentsResult({ agents: [snapshot("a", "running"), snapshot("b", "idle", "ok")] }, "", { expanded: false, isPartial: true }, theme);
	assert.match(some.render(100).join("\n").trim(), /Waiting for 1 of 2 agents · 48s$/);
});

test("finished agents show the start of their answer, with the full answer on expand", () => {
	const answer = "Line one\nLine two\nLine three\nLine four";
	const details = { agents: [snapshot("auth", "idle", answer), snapshot("db", "failed", undefined, "Pi exited with code 1")] };
	const collapsed = renderAgentsResult(details, "", { expanded: false, isPartial: false }, theme).render(100).join("\n");
	assert.match(collapsed, /✓ {2}reviewer {2}auth +48s/);
	assert.match(collapsed, / {2}Line one\n {2}Line two\n {2}Line three\n/);
	assert.doesNotMatch(collapsed, /Line four/);
	assert.match(collapsed, /✗ {2}reviewer {2}db {2}failed[\s\S]*Pi exited with code 1/);
	assert.match(collapsed, /for the full answers/);

	const expanded = renderAgentsResult(details, "", { expanded: true, isPartial: false }, theme).render(100).join("\n");
	assert.match(expanded, /Task: Review auth/);
	assert.match(expanded, /Line four/);
});

test("tool calls render while the model is still streaming their arguments", () => {
	// A real model streams arguments: fields appear one by one, so every one may be missing.
	for (const args of [undefined, {}, { agents: [] }, { agents: [{}] }, { agents: [{ type: "scout" }, null, 7] }, { agents: "x" }]) {
		assert.doesNotThrow(() => renderStartCall(args, theme).render(80), JSON.stringify(args));
	}
	assert.match(renderStartCall({ agents: [] }, theme).render(80)[0]!, /^Start agents$/);
	assert.match(renderStartCall({ agents: [{ type: "scout", task: "look  around" }] }, theme).render(80).join("\n"), /scout {2}look around/);
	for (const args of [undefined, {}, { names: [undefined, 3, "auth"] }]) {
		assert.doesNotThrow(() => renderWaitCall(args, theme).render(80));
	}
});

test("a failing renderer shows one line instead of ending the Pi session", () => {
	const broken = safely(() => ({ render: () => { throw new Error("boom"); }, invalidate() {} }));
	assert.deepEqual(broken.render(60), ["pi-subagents could not draw this: boom"]);
	assert.deepEqual(safely(() => { throw new Error("bad"); }).render(60), ["pi-subagents could not draw this: bad"]);
});

test("a running agent shows its own status first, with the current step after it", () => {
	const lines = renderAgentsWidget([agent("fix-auth", "worker", "running", "$ npm test", { status: "Fixing the refresh race" })], theme, 140);
	assert.match(lines[1]!, /fix-auth {2}Fixing the refresh race · \$ npm test /);
});

test("quick steps are held on screen instead of flickering", async () => {
	const { Subagent, STEP_HOLD_MS } = await import("../src/agent.ts");
	const child = { onEvent: () => () => {}, onUiRequest: () => () => {}, exited: new Promise(() => {}) };
	const agent = new Subagent({ name: "a", type: "worker", task: "t", model: "", sessionFile: "" }, child as never, async () => ({}));
	const start = 1_000_000;
	agent.activity = "reading a.ts";
	assert.equal(agent.step(start), "reading a.ts");
	agent.activity = "thinking";
	assert.equal(agent.step(start + 200), "reading a.ts", "a new step waits");
	agent.activity = "reading b.ts";
	assert.equal(agent.step(start + STEP_HOLD_MS - 1), "reading a.ts");
	assert.equal(agent.step(start + STEP_HOLD_MS), "reading b.ts", "then the latest step shows");
});

test("clicking an agent's row in the widget opens it; the header or hint opens the list", async () => {
	const { widgetClick } = await import("../src/ui/widget.ts");
	const agents = [{ info: { name: "auth-review" } }, { info: { name: "tests" } }] as never;
	const opened: (string | undefined)[] = [];
	const event = (type: "press" | "click", y: number) =>
		({ type, button: "left", x: 5, y, screenX: 5, screenY: y, width: 100, height: 4, shift: false, alt: false, ctrl: false }) as const;
	for (const y of [2, 0, 3]) {
		assert.ok(widgetClick(event("press", y), agents, (name) => opened.push(name))?.handled);
		widgetClick(event("click", y), agents, (name) => opened.push(name));
	}
	assert.deepEqual(opened, ["tests", undefined, undefined]);
	assert.equal(widgetClick(event("click", 4), agents, (name) => opened.push(name)), undefined, "below the widget");
});
