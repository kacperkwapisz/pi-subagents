import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentState, AgentUsage, Subagent } from "../agent.ts";
import { fitLine, formatCost, formatDuration, formatModel, formatTokens, stateIcon, typePill } from "./format.ts";

/** What a tool result remembers about an agent, so the chat can show it after the fact. */
export interface AgentSnapshot {
	name: string;
	type: string;
	task: string;
	state: AgentState;
	activity: string;
	elapsedMs: number;
	usage: AgentUsage;
	model: string;
	answer?: string;
	error?: string;
}

export interface AgentsDetails {
	agents: AgentSnapshot[];
}

export function snapshot(agent: Subagent): AgentSnapshot {
	return {
		name: agent.info.name,
		type: agent.info.type,
		task: agent.info.task,
		state: agent.state,
		activity: agent.activity,
		elapsedMs: agent.elapsedMs,
		usage: { ...agent.usage },
		model: agent.info.model,
		answer: agent.result,
		error: agent.error,
	};
}

/** Lines that are laid out for the available width when rendered. */
class Lines implements Component {
	private readonly build: (width: number) => string[];
	constructor(build: (width: number) => string[]) {
		this.build = build;
	}
	render(width: number): string[] {
		return this.build(width);
	}
	invalidate(): void {}
}

const PREVIEW_LINES = 3;

function summary(theme: Theme, agent: AgentSnapshot): string {
	const parts = [
		formatDuration(agent.elapsedMs),
		`↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)}`,
		formatCost(agent.usage.cost),
		agent.model ? formatModel(agent.model) : "",
	];
	return theme.fg("dim", parts.filter(Boolean).join("  "));
}

function headerLeft(theme: Theme, agent: AgentSnapshot, frame: number): string {
	const status =
		agent.state === "failed"
			? theme.fg("error", "failed")
			: agent.state === "stopped"
				? theme.fg("muted", "stopped")
				: agent.state === "idle"
					? ""
					: theme.fg("muted", agent.activity);
	return `${stateIcon(theme, agent.state, frame)} ${typePill(theme, agent.type)} ${theme.bold(agent.name)}${status ? `  ${status}` : ""}`;
}

/** The tool call line: which agents are being started, and on what. */
export function renderStartCall(agents: { type?: string; name?: string; task: string }[], theme: Theme): Component {
	return new Lines((width) => [
		theme.fg("toolTitle", theme.bold(agents.length === 1 ? "Start agent" : `Start ${agents.length} agents`)),
		...agents.map((agent) => {
			const type = agent.type ?? "worker";
			const name = agent.name ? `${theme.bold(agent.name)} ` : "";
			return truncateToWidth(`  ${typePill(theme, type)} ${name}${theme.fg("muted", agent.task.replace(/\s+/g, " "))}`, width);
		}),
	]);
}

export function renderWaitCall(names: string[] | undefined, theme: Theme): Component {
	const who = names?.length ? names.join(", ") : "running agents";
	return new Text(`${theme.fg("toolTitle", theme.bold("Wait for"))} ${theme.fg("muted", who)}`, 0, 0);
}

/**
 * The agents' progress while the tool waits, then each agent's outcome: collapsed shows the
 * first lines of every answer, expanded (Ctrl+O) the task and the full answer as Markdown.
 */
export function renderAgentsResult(
	details: AgentsDetails | undefined,
	fallbackText: string,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Component {
	const agents = details?.agents ?? [];
	if (agents.length === 0) return new Text(theme.fg("muted", fallbackText), 0, 0);
	const frame = Math.floor(Date.now() / 100);

	if (options.isPartial) {
		// The widget above the editor shows each agent while they work; one line is enough here.
		const working = agents.filter((agent) => agent.state === "starting" || agent.state === "running").length;
		const elapsed = Math.max(...agents.map((agent) => agent.elapsedMs));
		const label = working === agents.length ? `Waiting for ${agents.length === 1 ? agents[0]!.name : `${agents.length} agents`}` : `Waiting for ${working} of ${agents.length} agents`;
		return new Text(`${stateIcon(theme, "running", frame)} ${theme.fg("muted", label)} ${theme.fg("dim", `· ${formatDuration(elapsed)}`)}`, 0, 0);
	}

	if (!options.expanded) {
		return new Lines((width) => {
			const lines: string[] = [];
			let clipped = false;
			for (const agent of agents) {
				lines.push(fitLine(headerLeft(theme, agent, frame), summary(theme, agent), width));
				const body = agent.state === "failed" ? theme.fg("error", agent.error ?? "") : theme.fg("muted", agent.answer ?? "");
				const bodyLines = body.split("\n").filter((line) => line.trim());
				for (const line of bodyLines.slice(0, PREVIEW_LINES)) lines.push(truncateToWidth(`  ${line}`, width));
				if (bodyLines.length > PREVIEW_LINES) clipped = true;
			}
			if (clipped) lines.push(theme.fg("dim", `  ${keyHint("app.tools.expand", "for the full answers")}`));
			return lines;
		});
	}

	const container = new Container();
	const markdown = getMarkdownTheme();
	agents.forEach((agent, index) => {
		if (index > 0) container.addChild(new Text("", 0, 0));
		container.addChild(new Lines((width) => [fitLine(headerLeft(theme, agent, frame), summary(theme, agent), width)]));
		container.addChild(new Text(theme.fg("dim", `Task: ${agent.task}`), 2, 0));
		if (agent.state === "failed") container.addChild(new Text(theme.fg("error", agent.error ?? "Failed."), 2, 0));
		else if (agent.answer?.trim()) container.addChild(new Markdown(agent.answer.trim(), 2, 0, markdown));
		else container.addChild(new Text(theme.fg("muted", "(no answer)"), 2, 0));
	});
	return container;
}
