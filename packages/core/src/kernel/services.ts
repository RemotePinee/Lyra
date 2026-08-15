import type { Provider } from "../types.ts";
import type { Tool } from "../types.ts";

/**
 * The seams.
 *
 * Each key below is a capability that can be provided by one plugin and replaced by another
 * without anything that uses it being edited. Naming them in one file is deliberate: a seam is a
 * promise about a shape, and a promise scattered across the packages that happen to implement it
 * is one nobody can check.
 *
 * A key is added here only when there is a real second implementation in prospect. Seams invented
 * ahead of need are indistinguishable from indirection.
 */

/** `ctx.llm` — which model APIs the app can speak. */
export const LLM = "llm";

export interface LlmRegistry {
	/** Register an adapter for one API shape. Returns the disposer that removes it. */
	register(api: string, provider: Provider): () => void;
	get(api: string): Provider | undefined;
	list(): string[];
}

/** `ctx.tools` — what the agent can do. */
export const TOOLS = "tools";

export interface ToolRegistry {
	/**
	 * Contribute tools.
	 *
	 * Taken as a list because a plugin usually brings a related set — the filesystem tools, the
	 * web tools — and removing them individually is never what anyone wants.
	 */
	register(tools: Tool[]): () => void;
	all(): Tool[];
	byName(name: string): Tool | undefined;
}

/** `ctx.approval` — whether an action proceeds unattended. */
export const APPROVAL = "approval";

export interface ApprovalVerdict {
	risky: boolean;
	/** Why, in the user's language, when it is risky. */
	reason?: string;
}

export interface ApprovalPolicy {
	/**
	 * Judge one action.
	 *
	 * `subject` is the command, path or URL — the thing the decision is actually about, rather
	 * than the prose the model wrapped it in.
	 */
	assess(kind: string, subject: string, cwd: string): ApprovalVerdict;
}

/** `ctx.compaction` — how history is kept inside the model's window. */
export const COMPACTION = "compaction";

/** `ctx.storage` — where things that outlive a session are kept. */
export const STORAGE = "storage";

/**
 * Events every seam agrees on.
 *
 * Names are `subsystem/verb` in the past tense for things that happened, and imperative for
 * things being decided — the tense says whether a listener can still change the outcome.
 */
export const EVENTS = {
	/** A capability arrived or left. */
	serviceAdded: "service/added",
	serviceRemoved: "service/removed",
	/** A plugin finished applying. */
	pluginStarted: "plugin/started",
	/** Around-middleware over a single tool call: listeners may inspect, wrap or replace it. */
	toolCall: "tools/call",
	/** A turn is about to be sent; listeners may amend the context that goes with it. */
	turnPrepare: "agent/prepare",
} as const;
