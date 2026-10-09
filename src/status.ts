import type { Subagent } from "./agent.ts";

/**
 * Provider status pages through pi-subscription-usage, when it is installed (over pi.events,
 * so neither package needs the other). Used to explain failures: an outage on the provider's
 * side, or all well there so the problem is elsewhere.
 */
export const STATUS_EVENT = "pi-subscription-usage:status";
const TIMEOUT_MS = 4_000;

interface EventBus {
	emit(channel: string, data: unknown): void;
}

/** What pi-subscription-usage replies with (see its service-status.ts). */
type StatusReply =
	| { ok: true; status: { page: string; description: string; problems: string[] } }
	| { ok: false; page: string; error: string }
	| undefined;

/** "status.claude.com: Partially Degraded Service. Elevated errors on …", or undefined. */
export function statusFor(events: EventBus, model: string | undefined): Promise<string | undefined> {
	const provider = model?.split("/")[0];
	if (!provider) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), TIMEOUT_MS);
		timer.unref?.();
		const done = (text: string | undefined) => {
			clearTimeout(timer);
			resolve(text);
		};
		// pi-subscription-usage calls `accept` straight away when it will reply; without it
		// nothing answers and there is nothing to wait for.
		let accepted = false;
		events.emit(STATUS_EVENT, {
			provider,
			accept: () => (accepted = true),
			reply: (result: StatusReply) => {
				if (!result) return done(undefined);
				if (!result.ok) return done(`Couldn't check ${result.page}`);
				const { page, description, problems } = result.status;
				done(problems.length > 0 ? `${page}: ${description}. ${problems.join("; ")}` : `${page}: ${description}`);
			},
		});
		if (!accepted) done(undefined);
	});
}

/** Adds the provider's status to failed agents that don't have it yet. */
export async function annotateFailures(events: EventBus, agents: Subagent[]): Promise<void> {
	await Promise.all(
		agents
			.filter((agent) => agent.state === "failed" && agent.providerStatus === undefined)
			.map(async (agent) => {
				agent.providerStatus = (await statusFor(events, agent.info.model)) ?? "";
			}),
	);
}
