import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentState } from "../agent.ts";

type Color = Parameters<Theme["fg"]>[0];

/** "48s", "3m12s", "1h04m". */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** "800", "31.2k", "1.4M". */
export function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatCost(cost: number): string {
	if (cost <= 0) return "";
	return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

/**
 * "claude-opus-5 · account 3" for pi-multi-account's extra accounts (`anthropic-account-3`),
 * just the model for a provider's own login.
 */
export function formatModel(model: string): string {
	const slash = model.indexOf("/");
	if (slash === -1) return model;
	const provider = model.slice(0, slash);
	const id = model.slice(slash + 1);
	const account = provider.match(/-account-(\d+)$/)?.[1];
	return account ? `${id} · account ${account}` : id;
}

const TYPE_COLORS: Color[] = ["syntaxFunction", "syntaxKeyword", "syntaxString", "syntaxType", "mdHeading", "syntaxNumber", "accent", "success"];

/** A stable color per agent type, so a type looks the same everywhere. */
export function typeColor(type: string): Color {
	let hash = 0;
	for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return TYPE_COLORS[hash % TYPE_COLORS.length]!;
}

/** The agent type as a small colored badge. */
export function typePill(theme: Theme, type: string): string {
	return theme.bg("selectedBg", theme.fg(typeColor(type), theme.bold(` ${type} `)));
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function stateIcon(theme: Theme, state: AgentState, frame = 0): string {
	switch (state) {
		case "starting":
		case "running":
			return theme.fg("accent", SPINNER[frame % SPINNER.length]!);
		case "idle":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "stopped":
			return theme.fg("muted", "■");
	}
}

export function stateColor(state: AgentState): Color {
	return state === "failed" ? "error" : state === "idle" ? "success" : state === "stopped" ? "muted" : "text";
}

/** Left part truncated to make room; the right part (numbers) always stays whole. */
export function fitLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (!right) return truncateToWidth(left, width);
	if (rightWidth + 2 >= width) return truncateToWidth(left, width);
	const fitted = truncateToWidth(left, width - rightWidth - 2);
	return fitted + " ".repeat(Math.max(2, width - visibleWidth(fitted) - rightWidth)) + right;
}
