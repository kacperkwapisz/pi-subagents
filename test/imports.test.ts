import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Installed extensions get no dev dependencies: Pi itself supplies only these modules
 * (see pi-coding-agent's extension loader). Importing anything else works in this repo and
 * fails after `pi install`.
 */
const PROVIDED_BY_PI = new Set([
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/oauth",
	"@earendil-works/pi-ai/providers/all",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"typebox",
]);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
	);
}

test("source only imports what an installed extension can load", () => {
	const unsupported: string[] = [];
	for (const file of sourceFiles("src")) {
		for (const [, typeOnly, specifier] of readFileSync(file, "utf8").matchAll(/^import (type )?[^;]*?from "([^"]+)"/gms)) {
			const external = !specifier!.startsWith(".") && !specifier!.startsWith("node:");
			if (external && !typeOnly && !PROVIDED_BY_PI.has(specifier!)) unsupported.push(`${file}: ${specifier}`);
		}
	}
	assert.deepEqual(unsupported, []);
});
