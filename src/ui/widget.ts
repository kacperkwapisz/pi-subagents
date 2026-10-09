import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Subagent } from "../agent.ts";
import type { AgentManager } from "../manager.ts";
import { safeLines } from "./safe.ts";
import { describeWork, fitLine, formatCost, formatDuration, formatModel, formatTokens, stateIcon, typePill } from "./format.ts";

const WIDGET_KEY = "pi-subagents";
const FRAME_MS = 100;

function activityText(theme: Theme, agent: Subagent): string {
	switch (agent.state) {
		case "idle":
			return theme.fg("success", "done");
		case "failed":
			return theme.fg("error", `failed: ${(agent.error ?? "").split("\n")[0]}`);
		case "stopped":
			return theme.fg("muted", "stopped");
		default:
			return describeWork(theme, agent.status, agent.step());
	}
}

function metrics(theme: Theme, agent: Subagent, withModel: boolean): string {
	const parts = [
		withModel && agent.info.model ? theme.fg("dim", formatModel(agent.info.model, agent.info.thinking)) : "",
		theme.fg("muted", formatDuration(agent.elapsedMs)),
		theme.fg("dim", `↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)}`),
		theme.fg("muted", formatCost(agent.usage.cost)),
	];
	return parts.filter(Boolean).join("  ");
}

function counts(theme: Theme, agents: Subagent[]): string {
	const running = agents.filter((agent) => agent.busy).length;
	const done = agents.filter((agent) => agent.state === "idle").length;
	const failed = agents.filter((agent) => agent.state === "failed").length;
	return [
		running ? theme.fg("accent", `${running} running`) : "",
		done ? theme.fg("success", `${done} done`) : "",
		failed ? theme.fg("error", `${failed} failed`) : "",
	]
		.filter(Boolean)
		.join(theme.fg("dim", " · "));
}

/** The widget's lines: a header and one row per agent, tree-style. */
export function renderAgentsWidget(agents: Subagent[], theme: Theme, width: number, frame = 0): string[] {
	if (agents.length === 0) return [];
	const withModel = width >= 100;
	const lines = [fitLine(theme.fg("accent", theme.bold("Agents")), counts(theme, agents), width)];
	agents.forEach((agent, index) => {
		const branch = theme.fg("dim", index === agents.length - 1 ? "└─" : "├─");
		const left = `${branch} ${stateIcon(theme, agent.state, frame)} ${typePill(theme, agent.info.type)} ${theme.bold(agent.info.name)}  ${activityText(theme, agent)}`;
		lines.push(fitLine(left, metrics(theme, agent, withModel), width));
	});
	lines.push(theme.fg("dim", "← or /agents to watch and steer"));
	return lines;
}

/**
 * In fullscreen mode a click on an agent's row opens it in the browser; a click on the header
 * or the hint opens the browser. Rows follow renderAgentsWidget: header, one per agent, hint.
 */
export function widgetClick(
	event: TuiMouseEvent,
	agents: Subagent[],
	open: (name?: string) => void,
): TuiMouseEventResult | undefined {
	if (event.button !== "left" || event.y < 0 || event.y > agents.length + 1) return undefined;
	if (event.type === "press") return { handled: true, render: false };
	if (event.type !== "click") return undefined;
	open(agents[event.y - 1]?.info.name);
	return { handled: true };
}

/**
 * Keeps the agents widget above the editor in sync with the manager. An agent drops out once it
 * closes, or when the user sends a new message after it finished; agents still working stay.
 */
export class AgentsWidget {
	private readonly manager: AgentManager;
	private readonly context: () => ExtensionContext | undefined;
	private readonly open: (name?: string) => void;
	private readonly hidden = new WeakSet<Subagent>();
	private tui?: TUI;
	private installed = false;
	private frame = 0;
	private ticker?: ReturnType<typeof setInterval>;

	constructor(manager: AgentManager, context: () => ExtensionContext | undefined, open: (name?: string) => void = () => {}) {
		this.manager = manager;
		this.context = context;
		this.open = open;
		manager.onChange(() => this.update());
	}

	/** Agents still open: one leaves as soon as it closes (30s after finishing, by default). */
	visible(): Subagent[] {
		return this.manager.list().filter((agent) => !agent.closed && !this.hidden.has(agent));
	}

	/** On a new message from the user: finished agents leave the widget. */
	hideSettled(): void {
		for (const agent of this.manager.list()) if (!agent.busy) this.hidden.add(agent);
		this.update();
	}

	update(): void {
		const ctx = this.context();
		if (!ctx?.hasUI || ctx.mode !== "tui") return;
		const agents = this.visible();
		if (agents.length === 0) {
			if (this.installed) ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.installed = false;
			this.tui = undefined;
		} else if (!this.installed) {
			this.installed = true;
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => safeLines(() => renderAgentsWidget(this.visible(), theme, width, this.frame), width),
						handleMouse: (event: TuiMouseEvent) => {
							try {
								return widgetClick(event, this.visible(), this.open);
							} catch {
								return undefined;
							}
						},
						invalidate() {},
					};
				},
				{ placement: "aboveEditor" },
			);
		}
		this.tui?.requestRender();
		this.syncTicker(agents.some((agent) => agent.busy));
	}

	dispose(): void {
		this.syncTicker(false);
		if (this.installed) this.context()?.ui.setWidget(WIDGET_KEY, undefined);
		this.installed = false;
		this.tui = undefined;
	}

	private syncTicker(animate: boolean): void {
		if (animate && !this.ticker) {
			this.ticker = setInterval(() => {
				this.frame++;
				this.tui?.requestRender();
			}, FRAME_MS);
			this.ticker.unref?.();
		} else if (!animate && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}
}
