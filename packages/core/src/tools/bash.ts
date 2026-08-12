import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { errorResult } from "../agent/loop.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 60_000;

interface BashArgs {
	command: string;
	description?: string;
	timeout?: number;
	run_in_background?: boolean;
}

export interface BackgroundJob {
	id: string;
	command: string;
	startedAt: number;
	exitCode: number | null;
	output: string;
	kill: () => void;
}

export const BACKGROUND_JOBS_KEY = "backgroundJobs";

function jobs(ctx: ToolContext): Map<string, BackgroundJob> {
	let map = ctx.state.get(BACKGROUND_JOBS_KEY) as Map<string, BackgroundJob> | undefined;
	if (!map) {
		map = new Map();
		ctx.state.set(BACKGROUND_JOBS_KEY, map);
	}
	return map;
}

/**
 * Commands that are never worth an approval prompt: they read state and cannot mutate the
 * workspace. Anything not on this list goes through `requestApproval`.
 */
const READ_ONLY_COMMANDS = new Set([
	"ls", "pwd", "echo", "cat", "head", "tail", "wc", "which", "whoami", "date", "env",
	"grep", "rg", "find", "fd", "tree", "du", "df", "stat", "file", "basename", "dirname",
	"node", "python3", "go", "cargo", "rustc", "tsc",
]);

const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
	git: new Set(["status", "log", "diff", "show", "branch", "remote", "config", "ls-files", "rev-parse", "blame", "stash"]),
	npm: new Set(["ls", "view", "outdated", "run"]),
	pnpm: new Set(["ls", "view", "outdated", "why"]),
	docker: new Set(["ps", "images", "logs"]),
};

export function isReadOnlyCommand(command: string): boolean {
	// Any shell metacharacter can chain a mutating command onto a safe one.
	if (/[;&|><`$(){}]/.test(command)) return false;
	const parts = command.trim().split(/\s+/);
	const head = parts[0];
	if (!head) return false;
	if (READ_ONLY_COMMANDS.has(head)) return true;
	const sub = READ_ONLY_SUBCOMMANDS[head];
	return sub ? sub.has(parts[1] ?? "") : false;
}

export const bashTool: Tool<BashArgs> = {
	name: "bash",
	snippet: "Run shell commands",
	guidelines: [
		"Use the dedicated tools instead of their shell equivalents: read over `cat`, edit over `sed`, glob over `find`, grep over shell `grep`.",
		"Quote paths that may contain spaces.",
		"Use run_in_background for long-lived processes such as dev servers, then read them with bash_output.",
	],
	description:
		"Run a shell command in the workspace. The working directory persists between calls but shell state " +
		"(variables, functions) does not. Use `run_in_background: true` for long-running processes such as dev servers, " +
		"then read their output with `bash_output`. Prefer the dedicated file tools over cat/sed/echo.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "The command to run." },
			description: { type: "string", description: "5-10 word description shown to the user." },
			timeout: { type: "number", description: "Timeout in milliseconds. Default 120000, max 600000." },
			run_in_background: { type: "boolean", description: "Detach the process and return immediately." },
		},
		required: ["command"],
		additionalProperties: false,
	},
	mutating: true,
	summarize: (args) => args.description ?? args.command.split("\n")[0].slice(0, 80),

	async execute(args, ctx): Promise<ToolResult> {
		if (typeof args.command !== "string" || !args.command.trim()) {
			return errorResult("`command` is required.");
		}

		if (ctx.requestApproval && !isReadOnlyCommand(args.command)) {
			const decision = await ctx.requestApproval({
				kind: "bash",
				title: args.description ?? "Run shell command",
				detail: args.command,
				subject: args.command,
			});
			if (decision === "reject") return errorResult("The user rejected this command.");
		}

		if (args.run_in_background) return startBackground(args, ctx);

		const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
		return new Promise<ToolResult>((resolve) => {
			const child = spawn(args.command, {
				cwd: ctx.cwd,
				shell: process.env.SHELL || "/bin/bash",
				env: { ...process.env, TERM: "dumb", NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" },
			});

			let output = "";
			let settled = false;
			const append = (chunk: Buffer) => {
				if (output.length < MAX_OUTPUT_CHARS * 2) output += chunk.toString("utf8");
				ctx.onProgress?.({ content: [{ type: "text", text: clip(output) }] });
			};
			child.stdout.on("data", append);
			child.stderr.on("data", append);

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill("SIGKILL");
				resolve({
					content: [{ type: "text", text: `${clip(output)}\n\n[timed out after ${timeout}ms]` }],
					details: { kind: "bash", command: args.command, timedOut: true },
					isError: true,
				});
			}, timeout);

			const onAbort = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.kill("SIGKILL");
				resolve({
					content: [{ type: "text", text: `${clip(output)}\n\n[cancelled]` }],
					details: { kind: "bash", command: args.command, cancelled: true },
					isError: true,
				});
			};
			ctx.signal?.addEventListener("abort", onAbort, { once: true });

			child.on("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				ctx.signal?.removeEventListener("abort", onAbort);
				resolve(errorResult(`Failed to start command: ${error.message}`));
			});

			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				ctx.signal?.removeEventListener("abort", onAbort);
				const text = clip(output).trim();
				resolve({
					content: [{ type: "text", text: text || `(no output, exit code ${code ?? 0})` }],
					details: { kind: "bash", command: args.command, exitCode: code ?? 0 },
					isError: code !== 0,
				});
			});
		});
	},
};

function startBackground(args: BashArgs, ctx: ToolContext): ToolResult {
	const id = randomUUID().slice(0, 8);
	const child = spawn(args.command, {
		cwd: ctx.cwd,
		shell: process.env.SHELL || "/bin/bash",
		env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
		detached: false,
	});

	const job: BackgroundJob = {
		id,
		command: args.command,
		startedAt: Date.now(),
		exitCode: null,
		output: "",
		kill: () => child.kill("SIGKILL"),
	};
	const append = (chunk: Buffer) => {
		job.output = clip(job.output + chunk.toString("utf8"));
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	child.on("close", (code) => {
		job.exitCode = code ?? 0;
	});

	jobs(ctx).set(id, job);
	return {
		content: [{ type: "text", text: `Started background job ${id}. Read its output with bash_output({ id: "${id}" }).` }],
		details: { kind: "bash_background", id, command: args.command },
	};
}

interface BashOutputArgs {
	id: string;
	kill?: boolean;
}

export const bashOutputTool: Tool<BashOutputArgs> = {
	name: "bash_output",
	snippet: "Read output from a background job",
	description: "Read the accumulated output of a background job started by `bash`, and optionally kill it.",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string", description: "Job id returned by bash." },
			kill: { type: "boolean", description: "Terminate the job after reading its output." },
		},
		required: ["id"],
		additionalProperties: false,
	},
	summarize: (args) => `Check job ${args.id}`,

	async execute(args, ctx): Promise<ToolResult> {
		const job = jobs(ctx).get(args.id);
		if (!job) return errorResult(`No background job with id "${args.id}".`);
		if (args.kill) job.kill();
		const status = job.exitCode === null ? "running" : `exited with code ${job.exitCode}`;
		return {
			content: [{ type: "text", text: `[job ${job.id} ${status}]\n${job.output || "(no output yet)"}` }],
			details: { kind: "bash_output", id: job.id, exitCode: job.exitCode, command: job.command },
		};
	},
};

function clip(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	const half = Math.floor(MAX_OUTPUT_CHARS / 2);
	return `${text.slice(0, half)}\n\n… [${text.length - MAX_OUTPUT_CHARS} characters omitted] …\n\n${text.slice(-half)}`;
}
