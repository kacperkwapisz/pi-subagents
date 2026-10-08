import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Subagent } from "../agent.ts";
import type { AgentManager } from "../manager.ts";
import type { PendingQuestion, Questions } from "../questions.ts";
import { describeWork, fitLine, formatCost, formatDuration, formatModel, formatTokens, stateIcon, typePill } from "./format.ts";
import { safeLines } from "./safe.ts";
import { TranscriptRenderer } from "./transcript.ts";

const FRAME_MS = 100;
const FLASH_MS = 2500;
/** Below this width the agent list is hidden and ↑↓ still switch agents. */
const SIDE_BY_SIDE_WIDTH = 90;

interface Scroll {
	/** Following the newest output. */
	follow: boolean;
	/** Lines scrolled up from the bottom while not following. */
	offset: number;
}

export interface BrowserOptions {
	manager: AgentManager;
	questions: Questions;
	theme: Theme;
	tui: TUI;
	/** Agent to show first. */
	initial?: string;
	close: () => void;
}

function pad(line: string, width: number): string {
	const fitted = truncateToWidth(line, width);
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function stateWord(agent: Subagent): string {
	return agent.state === "idle" ? "done" : agent.state;
}

/**
 * The agents browser: every agent on the left, the selected agent's live transcript on the
 * right, and a box to steer it. Questions from an agent's extensions are answered here too.
 */
export class AgentsBrowser implements Component, Focusable {
	private readonly manager: AgentManager;
	private readonly questions: Questions;
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly close: () => void;
	private readonly transcripts: TranscriptRenderer;
	private readonly steerInput = new Input({ prompt: "❯ " });
	private readonly answerInput = new Input({ prompt: "❯ " });
	private readonly scroll = new Map<string, Scroll>();
	private readonly unsubscribe: (() => void)[] = [];
	private selected?: string;
	private confirmStop?: string;
	private flash?: { text: string; until: number };
	private frame = 0;
	private ticker?: ReturnType<typeof setInterval>;
	private hasFocus = false;
	private lastBodyHeight = 10;

	constructor(options: BrowserOptions) {
		this.manager = options.manager;
		this.questions = options.questions;
		this.theme = options.theme;
		this.tui = options.tui;
		this.close = options.close;
		this.selected = options.initial ?? options.manager.list().find((agent) => agent.busy)?.info.name ?? options.manager.list()[0]?.info.name;
		this.transcripts = new TranscriptRenderer(options.theme);
		this.steerInput.onSubmit = (value) => this.sendMessage(value, false);
		this.answerInput.onSubmit = (value) => this.answerText(value);
		const refresh = () => this.tui.requestRender();
		this.unsubscribe.push(this.manager.onChange(refresh), this.questions.onChange(refresh));
		this.ticker = setInterval(() => {
			this.frame++;
			if (this.manager.list().some((agent) => agent.busy) || this.flash) this.tui.requestRender();
		}, FRAME_MS);
		this.ticker.unref?.();
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		this.syncInputFocus();
	}

	dispose(): void {
		clearInterval(this.ticker);
		for (const stop of this.unsubscribe) stop();
	}

	invalidate(): void {}

	private agents(): Subagent[] {
		return this.manager.list();
	}

	private current(): Subagent | undefined {
		const agents = this.agents();
		return agents.find((agent) => agent.info.name === this.selected) ?? agents[0];
	}

	private question(): PendingQuestion | undefined {
		const agent = this.current();
		return agent ? this.questions.forAgent(agent) : undefined;
	}

	private syncInputFocus(): void {
		const question = this.question();
		const answering = !!question && (question.request.method === "input" || question.request.method === "editor");
		this.answerInput.focused = this.hasFocus && answering;
		this.steerInput.focused = this.hasFocus && !question;
	}

	private say(text: string): void {
		this.flash = { text, until: Date.now() + FLASH_MS };
	}

	// ----- input -----------------------------------------------------------------------------

	handleInput(data: string): void {
		try {
			this.handleKey(data);
		} catch {
			// A key must never take Pi down; the next render shows the current state.
		}
	}

	private handleKey(data: string): void {
		const question = this.question();
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			this.select(matchesKey(data, Key.up) ? -1 : 1);
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			this.page(matchesKey(data, Key.pageUp) ? 1 : -1);
		} else if (question) {
			this.handleAnswerKey(question, data);
		} else if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		} else if (matchesKey(data, Key.alt("enter"))) {
			this.sendMessage(this.steerInput.getValue(), true);
		} else if (matchesKey(data, Key.ctrl("c"))) {
			this.interrupt();
		} else if (matchesKey(data, Key.ctrl("x"))) {
			this.stop();
		} else {
			this.confirmStop = undefined;
			this.steerInput.handleInput(data);
		}
		this.syncInputFocus();
		this.tui.requestRender();
	}

	private select(step: number): void {
		const agents = this.agents();
		if (agents.length === 0) return;
		const index = Math.max(0, agents.findIndex((agent) => agent.info.name === this.current()?.info.name));
		this.selected = agents[(index + step + agents.length) % agents.length]!.info.name;
		this.confirmStop = undefined;
	}

	private page(direction: number): void {
		const agent = this.current();
		if (!agent) return;
		const state = this.scroll.get(agent.info.name) ?? { follow: true, offset: 0 };
		const step = Math.max(1, this.lastBodyHeight - 2);
		const offset = Math.max(0, state.offset + direction * step);
		this.scroll.set(agent.info.name, { follow: offset === 0, offset });
	}

	private sendMessage(text: string, followUp: boolean): void {
		const agent = this.current();
		const message = text.trim();
		if (!agent || !message) return;
		this.steerInput.setValue("");
		this.scroll.set(agent.info.name, { follow: true, offset: 0 });
		const wasBusy = agent.busy;
		agent
			.send(message, followUp)
			.then(() => this.say(wasBusy ? (followUp ? `Queued for ${agent.info.name}` : `Sent to ${agent.info.name}`) : `${agent.info.name} is on it`))
			.catch((error: Error) => {
				this.steerInput.setValue(message);
				this.say(error.message);
			})
			.finally(() => this.tui.requestRender());
	}

	private interrupt(): void {
		const agent = this.current();
		if (!agent?.busy) return;
		void agent.abort().then(() => this.say(`Interrupted ${agent.info.name}`));
	}

	private stop(): void {
		const agent = this.current();
		if (!agent) return;
		if (this.confirmStop !== agent.info.name) {
			this.confirmStop = agent.info.name;
			this.say(`Press Ctrl+X again to stop ${agent.info.name}`);
			return;
		}
		this.confirmStop = undefined;
		void this.manager.stop(agent.info.name).then(() => this.say(`Stopped ${agent.info.name}`));
		this.select(1);
	}

	private handleAnswerKey(question: PendingQuestion, data: string): void {
		const { method } = question.request;
		if (matchesKey(data, Key.escape)) return question.answer({ cancelled: true });
		if (method === "confirm") {
			if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) question.answer({ confirmed: true });
			else if (data === "n" || data === "N") question.answer({ confirmed: false });
		} else if (method === "select") {
			const options = (question.request.options as string[] | undefined) ?? [];
			const choice = /^[1-9]$/.test(data) ? options[Number(data) - 1] : undefined;
			if (choice !== undefined) question.answer({ value: choice });
		} else {
			this.answerInput.handleInput(data);
		}
	}

	private answerText(value: string): void {
		const question = this.question();
		if (!question) return;
		this.answerInput.setValue("");
		question.answer({ value });
	}

	// ----- rendering -------------------------------------------------------------------------

	render(width: number): string[] {
		return safeLines(() => this.renderView(width), width);
	}

	private renderView(width: number): string[] {
		const t = this.theme;
		const rows = this.tui.terminal.rows || 40;
		const height = Math.max(14, rows);
		const agents = this.agents();
		const agent = this.current();
		const question = this.question();
		const footer = this.renderFooter(width, agent, question);
		const bodyHeight = Math.max(4, height - 4 - footer.length);
		this.lastBodyHeight = bodyHeight;

		const rule = t.fg("border", "─".repeat(width));
		const lines = [t.fg("accent", "─".repeat(width)), this.renderHeader(width, agents)];

		const sideBySide = width >= SIDE_BY_SIDE_WIDTH && agents.length > 0;
		const listWidth = sideBySide ? Math.min(36, Math.max(26, Math.floor(width * 0.28))) : 0;
		const detailWidth = sideBySide ? width - listWidth - 3 : width - 1;
		lines.push(sideBySide ? t.fg("border", `${"─".repeat(listWidth + 1)}┬${"─".repeat(width - listWidth - 2)}`) : rule);

		const detail = agent ? this.renderDetail(agent, detailWidth, bodyHeight) : [t.fg("muted", "No agents yet. They appear here when the model starts some.")];
		const list = sideBySide ? this.renderList(agents, listWidth) : [];
		for (let row = 0; row < bodyHeight; row++) {
			const right = pad(detail[row] ?? "", detailWidth);
			lines.push(sideBySide ? `${pad(list[row] ?? "", listWidth)} ${t.fg("border", "│")} ${right}` : ` ${right}`);
		}

		lines.push(sideBySide ? t.fg("border", `${"─".repeat(listWidth + 1)}┴${"─".repeat(width - listWidth - 2)}`) : rule);
		lines.push(...footer);
		return lines.map((line) => pad(line, width));
	}

	private renderHeader(width: number, agents: Subagent[]): string {
		const t = this.theme;
		const running = agents.filter((agent) => agent.busy).length;
		const done = agents.filter((agent) => agent.state === "idle").length;
		const failed = agents.filter((agent) => agent.state === "failed").length;
		const counts = [
			running ? t.fg("accent", `${running} running`) : "",
			done ? t.fg("success", `${done} done`) : "",
			failed ? t.fg("error", `${failed} failed`) : "",
		].filter(Boolean);
		const index = agents.findIndex((agent) => agent === this.current());
		const position = width < SIDE_BY_SIDE_WIDTH && agents.length > 1 ? t.fg("dim", `  ‹ ${index + 1}/${agents.length} ›`) : "";
		const left = ` ${t.fg("accent", t.bold("Agents"))}  ${counts.join(t.fg("dim", " · "))}${position}`;
		return fitLine(left, t.fg("dim", "Esc close "), width);
	}

	private renderList(agents: Subagent[], width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		for (const agent of agents) {
			const selected = agent === this.current();
			const asking = !!this.questions.forAgent(agent);
			const pointer = selected ? t.fg("accent", ">") : " ";
			const name = selected ? t.fg("accent", t.bold(agent.info.name)) : t.bold(agent.info.name);
			lines.push(`${pointer} ${stateIcon(t, agent.state, this.frame)} ${name}`);
			const status = asking
				? t.fg("warning", "? needs your answer")
				: agent.busy
					? describeWork(t, agent.status, agent.step())
					: t.fg(agent.state === "failed" ? "error" : "muted", stateWord(agent));
			lines.push(truncateToWidth(`    ${t.fg("dim", `${agent.info.type} ·`)} ${status}`, width, "…"));
		}
		return lines;
	}

	private renderDetail(agent: Subagent, width: number, height: number): string[] {
		const t = this.theme;
		const model = agent.info.model ? t.fg("dim", formatModel(agent.info.model, agent.info.thinking)) : "";
		const left = `${t.bold(agent.info.name)} ${typePill(t, agent.info.type)} ${model}`;
		const numbers = [
			`${stateIcon(t, agent.state, this.frame)} ${t.fg(agent.state === "failed" ? "error" : "muted", stateWord(agent))}`,
			t.fg("muted", formatDuration(agent.elapsedMs)),
			t.fg("dim", `↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)}`),
			t.fg("muted", formatCost(agent.usage.cost)),
		].filter(Boolean);
		const header = fitLine(left, numbers.join("  "), width);

		const transcript = this.transcripts.render(agent.transcript, width, this.frame);
		if (agent.state === "failed" && agent.error) transcript.push("", t.fg("error", `✗ ${agent.error}`));
		const viewport = height - 2;
		const scroll = this.scroll.get(agent.info.name) ?? { follow: true, offset: 0 };
		const offset = scroll.follow ? 0 : Math.min(scroll.offset, Math.max(0, transcript.length - viewport));
		const end = transcript.length - offset;
		const visible = transcript.slice(Math.max(0, end - viewport), end);
		if (offset > 0) visible[visible.length - 1] = t.fg("dim", `↓ ${offset} more lines · PgDn to follow`);
		return [header, t.fg("dim", "─".repeat(width)), ...visible];
	}

	private renderFooter(width: number, agent: Subagent | undefined, question: PendingQuestion | undefined): string[] {
		const t = this.theme;
		if (question) {
			const { method, title, message } = question.request;
			const lines = [t.fg("warning", t.bold(` ? ${question.agent.info.name} asks: ${String(title ?? "")}`))];
			if (typeof message === "string" && message) lines.push(t.fg("muted", ` ${message}`));
			if (method === "confirm") {
				lines.push(t.fg("dim", " y yes · n no · Esc skip"));
			} else if (method === "select") {
				const options = ((question.request.options as string[] | undefined) ?? []).slice(0, 9);
				lines.push(` ${options.map((option, i) => `${t.fg("accent", String(i + 1))} ${option}`).join("   ")}`);
				lines.push(t.fg("dim", " Press a number · Esc skip"));
			} else {
				lines.push(` ${this.answerInput.render(width - 2)[0] ?? ""}`, t.fg("dim", " Enter answer · Esc skip"));
			}
			return lines.map((line) => truncateToWidth(line, width));
		}

		const placeholder = agent ? (agent.busy ? `Steer ${agent.info.name}…` : `Give ${agent.info.name} more work…`) : "";
		const input = this.steerInput.getValue() ? (this.steerInput.render(width - 2)[0] ?? "") : `${t.fg("accent", "❯")} ${t.fg("dim", placeholder)}`;
		const flash = this.flash && this.flash.until > Date.now() ? this.flash.text : undefined;
		if (!flash) this.flash = undefined;
		const hints = flash
			? t.fg("warning", ` ${flash}`)
			: t.fg("dim", " Enter steer · Alt+Enter follow-up · ↑↓ agent · PgUp/PgDn scroll · Ctrl+C interrupt · Ctrl+X stop");
		return [` ${input}`, truncateToWidth(hints, width)];
	}
}
