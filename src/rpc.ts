import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

/** A record a child Pi writes in RPC mode: a session event, a response, or an extension UI request. */
export interface RpcRecord {
	type: string;
	[key: string]: unknown;
}

/** A question or notice from an extension running inside the child (see Pi's RPC extension UI docs). */
export interface UiRequest extends RpcRecord {
	type: "extension_ui_request";
	id: string;
	method: string;
}

export interface PiCommand {
	command: string;
	args: string[];
}

/**
 * How to start the Pi that is running this extension: the same Node and CLI script when Pi
 * runs on Node, the binary itself when it is compiled, `pi` from PATH as a last resort.
 */
export function currentPi(): PiCommand {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
		return { command: process.execPath, args: [script] };
	}
	if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args: [] };
	return { command: "pi", args: [] };
}

export interface RpcChildOptions {
	cwd: string;
	/** Arguments after `--mode rpc`. */
	args: string[];
	env?: Record<string, string>;
	/** Which Pi to run; defaults to the running one. */
	pi?: PiCommand;
}

interface Pending {
	resolve(data: unknown): void;
	reject(error: Error): void;
}

const STDERR_LIMIT = 64 * 1024;

/**
 * One Pi process in RPC mode (JSON lines on stdin and stdout). Unlike Pi's `RpcClient`, it
 * keeps the child's stderr to itself, so nothing is written over the parent's terminal UI.
 */
export class RpcChild {
	private readonly options: RpcChildOptions;
	private process?: ChildProcess;
	private readonly pending = new Map<string, Pending>();
	private readonly eventListeners = new Set<(record: RpcRecord) => void>();
	private readonly uiListeners = new Set<(request: UiRequest) => void>();
	private nextId = 1;
	private stderr = "";
	private exitError?: Error;
	readonly exited: Promise<void>;
	private markExited!: () => void;

	constructor(options: RpcChildOptions) {
		this.options = options;
		this.exited = new Promise((resolve) => (this.markExited = resolve));
	}

	start(): void {
		const pi = this.options.pi ?? currentPi();
		const child = spawn(pi.command, [...pi.args, "--mode", "rpc", ...this.options.args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;

		let buffer = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => {
			// Split on LF only: JSON strings may contain U+2028/U+2029, which readline would split on.
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line.trim()) this.handleLine(line);
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
		});
		const fail = (error: Error) => {
			this.exitError ??= error;
			for (const { reject } of this.pending.values()) reject(this.exitError);
			this.pending.clear();
		};
		child.once("error", (error) => fail(new Error(`Could not start Pi: ${error.message}`)));
		child.once("exit", (code, signal) => {
			fail(new Error(this.describeExit(code, signal)));
			this.markExited();
		});
	}

	/** Sends a command and resolves with its response data. */
	send(command: RpcRecord): Promise<unknown> {
		if (this.exitError) return Promise.reject(this.exitError);
		if (!this.process?.stdin?.writable) return Promise.reject(new Error("Pi is not running"));
		const id = `c${this.nextId++}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.process!.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	/** Answers a dialog an extension inside the child opened. */
	respond(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
		this.process?.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`);
	}

	onEvent(listener: (record: RpcRecord) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onUiRequest(listener: (request: UiRequest) => void): () => void {
		this.uiListeners.add(listener);
		return () => this.uiListeners.delete(listener);
	}

	get running(): boolean {
		return !!this.process && this.process.exitCode === null && this.process.signalCode === null;
	}

	/** The last part of what the child wrote to stderr, for error messages. */
	get errorOutput(): string {
		return this.stderr.trim();
	}

	/** Stops the process: SIGTERM, then SIGKILL if it has not exited within a second. */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.process!.kill("SIGTERM");
		const timer = setTimeout(() => this.process?.kill("SIGKILL"), 1000);
		await this.exited;
		clearTimeout(timer);
	}

	private handleLine(line: string): void {
		let record: RpcRecord;
		try {
			record = JSON.parse(line) as RpcRecord;
		} catch {
			return; // not a protocol record
		}
		if (record.type === "response" && typeof record.id === "string") {
			const pending = this.pending.get(record.id);
			if (!pending) return;
			this.pending.delete(record.id);
			if (record.success === false) pending.reject(new Error(String(record.error ?? "Command failed")));
			else pending.resolve(record.data);
			return;
		}
		if (record.type === "extension_ui_request") {
			for (const listener of this.uiListeners) listener(record as UiRequest);
			return;
		}
		for (const listener of this.eventListeners) listener(record);
	}

	private describeExit(code: number | null, signal: NodeJS.Signals | null): string {
		const how = signal ? `was stopped (${signal})` : `exited with code ${code}`;
		const detail = this.errorOutput.split("\n").slice(-5).join("\n");
		return detail ? `Pi ${how}: ${detail}` : `Pi ${how}`;
	}
}
