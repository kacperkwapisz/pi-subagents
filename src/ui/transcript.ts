import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TranscriptItem } from "../agent.ts";
import { SPINNER } from "./format.ts";

const PREVIEW_LINES = 3;

/** A tool call in the short forms Pi itself uses: `$ npm test`, `read src/a.ts`, `grep /x/ in src`. */
export function toolLabel(name: string, args: Record<string, unknown>): string {
	const arg = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
	switch (name) {
		case "bash":
			return `$ ${arg("command").split("\n")[0]}`;
		case "read": {
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			const range = offset !== undefined ? `:${offset}${limit !== undefined ? `-${offset + limit - 1}` : ""}` : "";
			return `read ${arg("path")}${range}`;
		}
		case "edit":
		case "write":
			return `${name} ${arg("path")}`;
		case "grep":
			return `grep /${arg("pattern")}/${arg("path") ? ` in ${arg("path")}` : ""}`;
		case "find":
			return `find ${arg("pattern")}${arg("path") ? ` in ${arg("path")}` : ""}`;
		case "ls":
			return `ls ${arg("path") || "."}`;
		default: {
			const json = JSON.stringify(args);
			return json && json !== "{}" ? `${name} ${json}` : name;
		}
	}
}

function preview(text: string, width: number, style: (line: string) => string, lines = PREVIEW_LINES): string[] {
	const all = text.split("\n").filter((line) => line.trim());
	const shown = all.slice(0, lines).map((line) => truncateToWidth(`  ${style(line)}`, width));
	const more = all.length - lines;
	if (more > 0) shown.push(style(`  … ${more} more line${more === 1 ? "" : "s"}`));
	return shown;
}

/** Renders transcript items, remembering each item's lines until it changes. */
export class TranscriptRenderer {
	private readonly cache = new WeakMap<TranscriptItem, { key: string; lines: string[] }>();
	private readonly theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	render(items: readonly TranscriptItem[], width: number, frame: number): string[] {
		const lines: string[] = [];
		items.forEach((item, index) => {
			if (index > 0) lines.push("");
			lines.push(...this.renderItem(item, width, frame));
		});
		return lines;
	}

	private renderItem(item: TranscriptItem, width: number, frame: number): string[] {
		// Running tool calls animate, so they are never cached.
		const key = `${width}|${JSON.stringify(item)}`;
		const cached = this.cache.get(item);
		if (cached?.key === key && !(item.kind === "tool" && item.status === "running")) return cached.lines;
		const lines = this.build(item, width, frame);
		this.cache.set(item, { key, lines });
		return lines;
	}

	private build(item: TranscriptItem, width: number, frame: number): string[] {
		const t = this.theme;
		switch (item.kind) {
			case "prompt": {
				const title = { task: "Task", steer: "You · steer", "follow-up": "You · follow-up", message: "You" }[item.via];
				return [
					t.fg("accent", t.bold(`▸ ${title}`)),
					...wrapTextWithAnsi(item.text, Math.max(1, width - 2)).map((line) => `  ${line}`),
				];
			}
			case "text":
				return item.text.trim() ? new Markdown(item.text.trim(), 0, 0, getMarkdownTheme()).render(width) : [];
			case "thinking":
				return preview(item.text, width, (line) => t.fg("thinkingText", line)).map((line, i) => (i === 0 ? line.replace(/^ {2}/, "∴ ") : line));
			case "tool": {
				const icon =
					item.status === "running"
						? t.fg("accent", SPINNER[frame % SPINNER.length]!)
						: item.status === "error"
							? t.fg("error", "✗")
							: t.fg("success", "✓");
				const label = truncateToWidth(`${icon} ${t.fg("toolTitle", toolLabel(item.name, item.args))}`, width);
				const style = (line: string) => t.fg(item.status === "error" ? "error" : "dim", line);
				return [label, ...preview(item.output, width, style)];
			}
			case "notice": {
				const icon = item.level === "error" ? "✗" : item.level === "warning" ? "⚠" : "ℹ";
				const color = item.level === "info" ? "muted" : item.level;
				return wrapTextWithAnsi(t.fg(color, `${icon} ${item.text}`), width);
			}
		}
	}
}
