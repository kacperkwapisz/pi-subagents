import type { Subagent } from "./agent.ts";
import type { UiRequest } from "./rpc.ts";

export interface Answer {
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

export interface PendingQuestion {
	agent: Subagent;
	request: UiRequest;
	answer(answer: Answer): void;
}

type DialogAsker = (agent: Subagent, request: UiRequest) => Promise<Answer>;

/**
 * Questions from extensions inside subagents (confirmations, choices, text). While the agents
 * browser is open they are answered inside it; otherwise they open Pi's normal dialogs.
 */
export class Questions {
	private readonly askInDialog: DialogAsker;
	private pending: PendingQuestion[] = [];
	private inline = false;
	private readonly listeners = new Set<() => void>();

	constructor(askInDialog: DialogAsker) {
		this.askInDialog = askInDialog;
	}

	ask(agent: Subagent, request: UiRequest): Promise<Answer> {
		if (!this.inline) return this.askInDialog(agent, request);
		return new Promise((resolve) => {
			const question: PendingQuestion = {
				agent,
				request,
				answer: (answer) => {
					this.pending = this.pending.filter((candidate) => candidate !== question);
					resolve(answer);
					this.changed();
				},
			};
			this.pending.push(question);
			this.changed();
		});
	}

	/** The oldest unanswered question from this agent. */
	forAgent(agent: Subagent): PendingQuestion | undefined {
		return this.pending.find((question) => question.agent === agent);
	}

	/** While the browser is open, questions go there; on close, unanswered ones become dialogs. */
	setInline(inline: boolean): void {
		this.inline = inline;
		if (inline) return;
		const waiting = this.pending;
		this.pending = [];
		for (const question of waiting) {
			void this.askInDialog(question.agent, question.request)
				.catch((): Answer => ({ cancelled: true }))
				.then((answer) => question.answer(answer));
		}
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}
