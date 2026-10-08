import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import type { Subagent, TranscriptItem } from "../src/agent.ts";
import type { AgentManager } from "../src/manager.ts";
import { type Answer, Questions } from "../src/questions.ts";
import type { UiRequest } from "../src/rpc.ts";
import { AgentsBrowser } from "../src/ui/browser.ts";

initTheme("dark"); // Pi does this at startup; Markdown needs it
const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", altEnter: "\x1b\r", esc: "\x1b", ctrlX: "\x18", ctrlC: "\x03" };

function fakeAgent(name: string, state: Subagent["state"], transcript: TranscriptItem[] = []) {
	const sent: { message: string; followUp: boolean }[] = [];
	const agent = {
		info: { name, type: "reviewer", task: `task of ${name}`, model: "anthropic-account-3/claude-opus-5", sessionFile: "" },
		state,
		activity: state === "running" ? "reading src/auth.ts" : "done",
		usage: { input: 12_400, output: 800, cost: 0.04 },
		elapsedMs: 72_000,
		busy: state === "running",
		step: () => (state === "running" ? "reading src/auth.ts" : "done"),
		transcript,
		send: async (message: string, followUp = false) => void sent.push({ message, followUp }),
		abort: async () => {},
	} as unknown as Subagent;
	return { agent, sent };
}

function setup(agents: Subagent[], rows = 30, keybindings?: KeybindingsManager) {
	const stopped: string[] = [];
	const manager = {
		list: () => agents,
		onChange: () => () => {},
		stop: async (name: string) => void stopped.push(name),
	} as unknown as AgentManager;
	const questions = new Questions(async () => ({ cancelled: true }));
	questions.setInline(true);
	let closed = false;
	const tui = { terminal: { rows }, requestRender: () => {} } as unknown as TUI;
	const browser = new AgentsBrowser({ manager, questions, theme, tui, keybindings, close: () => (closed = true) });
	const type = (text: string) => {
		for (const char of text) browser.handleInput(char);
	};
	return { browser, questions, stopped, type, isClosed: () => closed };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("side by side: the agents on the left, the selected agent's live transcript on the right", () => {
	const auth = fakeAgent("auth-review", "running", [
		{ kind: "prompt", text: "Review the auth module", via: "task" },
		{ kind: "tool", id: "1", name: "read", args: { path: "src/auth.ts" }, status: "done", output: "line 1\nline 2\nline 3\nline 4" },
		{ kind: "notice", text: "Anthropic account 1 hit its usage limit. Continuing on account 2.", level: "warning" },
		{ kind: "text", text: "Found **two** races." },
	]);
	const files = fakeAgent("files", "idle");
	const { browser } = setup([auth.agent, files.agent]);
	const width = 120;
	const lines = browser.render(width);
	const text = lines.join("\n");
	assert.ok(lines.every((line) => visibleWidth(line) === width), "every line fills the overlay");
	assert.equal(lines.length, 30, "the whole terminal height");
	assert.match(text, /Agents {2}1 running · 1 done +Esc close/);
	assert.match(text, /> [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] auth-review +│ auth-review {2}reviewer {2}claude-opus-5 · account 3/);
	assert.match(text, / {4}reviewer · reading src\/au[^│]*…[^│]*│/, "long activity is cut with …");
	assert.match(text, / {2}✓ files +│/);
	assert.match(text, /│ ▸ Task/);
	assert.match(text, /│ ✓ read src\/auth\.ts/);
	assert.match(text, /│ {3}line 3/);
	assert.match(text, /│ {3}… 1 more line /);
	assert.match(text, /│ ⚠ Anthropic account 1 hit its usage limit\. Continuing on account 2\./);
	assert.match(text, /│ Found two races\./);
	assert.match(text, /❯ Steer auth-review…/);
});

test("on a narrow terminal the list is hidden and the header says which agent this is", () => {
	const { browser } = setup([fakeAgent("a", "running").agent, fakeAgent("b", "idle").agent]);
	const text = browser.render(70).join("\n");
	assert.match(text, /Agents .*‹ 1\/2 ›/);
	assert.doesNotMatch(text, /│/);
});

test("typing steers the selected agent; Alt+Enter queues a follow-up; ↑↓ switch agents", async () => {
	const first = fakeAgent("first", "running");
	const second = fakeAgent("second", "idle");
	const { browser, type } = setup([first.agent, second.agent]);
	type("focus on refresh");
	browser.handleInput(KEYS.enter);
	type("then summarise");
	browser.handleInput(KEYS.altEnter);
	browser.handleInput(KEYS.down);
	type("new work");
	browser.handleInput(KEYS.enter);
	await tick();
	assert.deepEqual(first.sent, [
		{ message: "focus on refresh", followUp: false },
		{ message: "then summarise", followUp: true },
	]);
	assert.deepEqual(second.sent, [{ message: "new work", followUp: false }]);
	assert.match(browser.render(120).join("\n"), /second is on it/);
});

test("Ctrl+X stops an agent only on the second press; Esc closes", async () => {
	const { browser, stopped, isClosed } = setup([fakeAgent("only", "running").agent]);
	browser.handleInput(KEYS.ctrlX);
	assert.deepEqual(stopped, []);
	assert.match(browser.render(120).join("\n"), /Press Ctrl\+X again to stop only/);
	browser.handleInput(KEYS.ctrlX);
	await tick();
	assert.deepEqual(stopped, ["only"]);
	browser.handleInput(KEYS.esc);
	assert.ok(isClosed());
});

test("questions from an agent are answered in the browser", async () => {
	const asker = fakeAgent("deploy", "running");
	const { browser, questions, type } = setup([asker.agent]);
	const ask = (request: Partial<UiRequest>) =>
		questions.ask(asker.agent, { type: "extension_ui_request", id: "q", ...request } as UiRequest);

	const confirmed = ask({ method: "confirm", title: "Run rm -rf build?", message: "This deletes files." });
	let text = browser.render(120).join("\n");
	assert.match(text, /\? deploy asks: Run rm -rf build\?/);
	assert.match(text, /y yes · n no · Esc skip/);
	browser.handleInput("y");
	assert.deepEqual(await confirmed, { confirmed: true } satisfies Answer);

	const chosen = ask({ method: "select", title: "Which account?", options: ["work", "personal"] });
	assert.match(browser.render(120).join("\n"), /1 work {3}2 personal/);
	browser.handleInput("2");
	assert.deepEqual(await chosen, { value: "personal" });

	const typed = ask({ method: "input", title: "Branch name?" });
	type("fix/auth");
	browser.handleInput(KEYS.enter);
	assert.deepEqual(await typed, { value: "fix/auth" });

	const skipped = ask({ method: "confirm", title: "Push?" });
	browser.handleInput(KEYS.esc);
	assert.deepEqual(await skipped, { cancelled: true });
	text = browser.render(120).join("\n");
	assert.match(text, /❯ Steer deploy…/, "back to steering");
});

const mouse = (type: TuiMouseEvent["type"], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
	type,
	button: type === "wheel" ? "none" : "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 120,
	height: 30,
	shift: false,
	alt: false,
	ctrl: false,
	...extra,
});
const click = (browser: AgentsBrowser, x: number, y: number) => {
	const press = browser.handleMouse(mouse("press", x, y));
	return press?.handled ? browser.handleMouse(mouse("click", x, y)) : undefined;
};

test("mouse: clicking an agent in the list selects it; the wheel scrolls the transcript", () => {
	const long = Array.from({ length: 80 }, (_, i) => ({ kind: "text" as const, text: `line ${i}` }));
	const first = fakeAgent("first", "running", long);
	const second = fakeAgent("second", "idle");
	const { browser } = setup([first.agent, second.agent]);
	const body = (lines: string[]) => lines.slice(3).join("\n");
	browser.render(120);

	// Rows 3-4 are the first agent, 5-6 the second.
	assert.ok(click(browser, 4, 5)?.handled);
	assert.match(body(browser.render(120)), /> . second/);

	assert.ok(click(browser, 4, 3)?.handled);
	assert.match(body(browser.render(120)), /> . first/);
	assert.match(body(browser.render(120)), /line 79/, "follows the newest output");

	assert.ok(browser.handleMouse(mouse("wheel", 60, 10, { wheelDelta: -20 }))?.handled);
	const scrolled = body(browser.render(120));
	assert.doesNotMatch(scrolled, /line 79/);
	assert.match(scrolled, /↓ 20 more lines/);
	browser.handleMouse(mouse("wheel", 60, 10, { wheelDelta: 20 }));
	assert.match(body(browser.render(120)), /line 79/, "scrolling back down follows again");

	// The wheel over the list moves between agents.
	browser.handleMouse(mouse("wheel", 4, 4, { wheelDelta: 3 }));
	assert.match(body(browser.render(120)), /> . second/);
	// Presses in the transcript are left alone, so text can still be selected there.
	assert.equal(browser.handleMouse(mouse("press", 60, 10)), undefined);
});

test("the user's own key bindings work in the browser and show in its hints", () => {
	const a = fakeAgent("a", "idle");
	const b = fakeAgent("b", "idle");
	const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.cancel": "ctrl+q" });
	const { browser, isClosed } = setup([a.agent, b.agent], 30, keys);
	browser.handleInput("\x0e"); // ctrl+n
	const view = browser.render(120).join("\n");
	assert.match(view, /> . b/);
	assert.match(view, /Ctrl\+Q close/);
	assert.match(view, /↑Ctrl\+N agent/);
	browser.handleInput("\x11"); // ctrl+q
	assert.equal(isClosed(), true);
});
