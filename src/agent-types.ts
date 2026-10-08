import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** A kind of subagent, defined by a Markdown file with frontmatter (same format as Pi's example). */
export interface AgentType {
	name: string;
	description: string;
	/** Tool allowlist; all of Pi's defaults when absent. */
	tools?: string[];
	/** `provider/model` or a model id; the parent's model when absent. */
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "bundled" | "user" | "project";
}

const BUNDLED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

/** Accepts `tools: read, bash` and `tools: [read, bash]`; anything else means no restriction. */
function toolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function loadAgentTypesFromDir(dir: string, source: AgentType["source"]): AgentType[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const types: AgentType[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(dir, entry.name), "utf-8"));
			const name = text(frontmatter.name);
			const description = text(frontmatter.description);
			if (!name || !description) continue;
			types.push({
				name,
				description,
				tools: toolList(frontmatter.tools),
				model: text(frontmatter.model),
				thinking: text(frontmatter.thinking),
				systemPrompt: body,
				source,
			});
		} catch {
			// One broken file must not hide every other agent type.
		}
	}
	return types;
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
	let dir = cwd;
	while (true) {
		const candidate = join(dir, CONFIG_DIR_NAME, "agents");
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		} catch {
			// keep looking
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Every agent type: the bundled ones, then the user's (`~/.pi/agent/agents`), then the
 * project's (`.pi/agents`, only in projects Pi trusts). Later ones override earlier ones by name.
 */
export function discoverAgentTypes(cwd: string, projectTrusted: boolean): AgentType[] {
	const byName = new Map<string, AgentType>();
	const projectDir = projectTrusted ? nearestProjectAgentsDir(cwd) : undefined;
	for (const type of [
		...loadAgentTypesFromDir(BUNDLED_DIR, "bundled"),
		...loadAgentTypesFromDir(join(getAgentDir(), "agents"), "user"),
		...(projectDir ? loadAgentTypesFromDir(projectDir, "project") : []),
	]) {
		byName.set(type.name, type);
	}
	return [...byName.values()];
}
