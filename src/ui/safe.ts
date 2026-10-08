import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Pi ends the whole session when a component throws while rendering. Our UI must never do
 * that: a failure shows one line instead, and everything else keeps working.
 */
export function safeLines(render: () => string[], width: number): string[] {
	try {
		return render();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [truncateToWidth(`pi-subagents could not draw this: ${message}`, Math.max(1, width))];
	}
}

/** Wraps a component so neither building it nor rendering it can throw into Pi. */
export function safely(build: () => Component): Component {
	let component: Component | undefined;
	let failure: string | undefined;
	try {
		component = build();
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	if (!component) {
		return { render: (width: number) => [truncateToWidth(`pi-subagents could not draw this: ${failure}`, Math.max(1, width))], invalidate() {} };
	}
	return {
		render: (width: number) => safeLines(() => component!.render(width), width),
		invalidate: () => component!.invalidate(),
	};
}
