/**
 * What a tool is, what it is given, and what it may have to ask first.
 *
 * A tool is a spec the model sees plus a function the runtime calls. Everything it needs to do its
 * job — where it runs, how to say something, how to ask permission, how to delegate — arrives in
 * one context object rather than through imports, which is what lets a host substitute any of it.
 */

import type { UserContent } from "./message.ts";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** JSON Schema subset accepted by every provider we target. */
export interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema | JsonSchema[];
	required?: string[];
	enum?: unknown[];
	description?: string;
	default?: unknown;
	additionalProperties?: boolean | JsonSchema;
	[key: string]: unknown;
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: JsonSchema;
}

export interface ToolResult {
	/** What the model sees. */
	content: UserContent[];
	/** What the UI renders. Never serialized into the provider payload. */
	details?: unknown;
	isError?: boolean;
	/** End the agent turn after this tool, even if the model wanted to keep going. */
	terminate?: boolean;
}

export interface ToolContext {
	/** Absolute working directory for this session. */
	cwd: string;
	sessionId: string;
	signal?: AbortSignal;
	/** Push an in-progress result so the UI can stream long-running tools. */
	onProgress?: (partial: ToolResult) => void;
	/** Ask the user to approve a side-effecting operation. */
	requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
	/** Run a nested agent (used by the `task` tool). */
	spawnSubAgent?: (input: SubAgentInput) => Promise<string>;
	/** Shared per-session scratch space (todo list, file read cache, ...). */
	state: Map<string, unknown>;
	/**
	 * Store a web preview and return where it went.
	 *
	 * Provided by the host, because where these files live is the host's business — they are
	 * conversation artifacts kept under the app's own directory, never in the user's project.
	 */
	writePreview?: (input: {
		id: string;
		title: string;
		files: { path: string; content: string }[];
		entry?: string;
	}) => Promise<{ id: string; sessionId: string; title: string; entry: string; dir: string }>;
	logger?: Logger;
}

export interface ApprovalRequest {
	kind: "bash" | "write" | "edit" | "mcp" | "network";
	title: string;
	detail: string;
	/** Command / path the approval applies to, used for "always allow" rules. */
	subject: string;
}

export type ApprovalDecision = "once" | "always" | "reject";

export interface SubAgentInput {
	description: string;
	prompt: string;
	agentType?: string;
	model?: string;
}

export interface Tool<TArgs = Record<string, unknown>> extends ToolSpec {
	/**
	 * One line for the system prompt's tool list. The full `description` goes to the provider's
	 * tool schema; this is what the model reads when scanning what it has available.
	 */
	snippet: string;
	/**
	 * Behavioural rules this tool contributes to the prompt's Guidelines section. Keeping them
	 * next to the tool means a tool that is not loaded cannot leave stale advice behind.
	 */
	guidelines?: string[];
	/** "sequential" forces the loop to run this tool alone, in call order. */
	executionMode?: "parallel" | "sequential";
	/** Tools that mutate the workspace go through the approval flow. */
	mutating?: boolean;
	execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
	/** One-line summary shown in the UI while the tool runs. */
	summarize?(args: TArgs): string;
}

export interface Logger {
	debug(msg: string, meta?: unknown): void;
	info(msg: string, meta?: unknown): void;
	warn(msg: string, meta?: unknown): void;
	error(msg: string, meta?: unknown): void;
}
