import type { Skill } from "../skills/loader.ts";
import type { Message, ModelConfig, Provider, ProviderConfig, Tool } from "../types.ts";

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

/** `ctx.skills` — the procedures the agent knows how to follow. */
export const SKILLS = "skills";

export interface SkillRegistry {
	/**
	 * Contribute skills.
	 *
	 * Skills normally arrive as directories on disk, which is right for something a user writes.
	 * This is the other door: a plugin that brings its own procedures — a house code review, a
	 * deploy runbook — without asking the user to place files for it.
	 */
	register(skills: Skill[]): () => void;
	all(): Skill[];
}

/** `ctx.sandbox` — where commands actually run. */
export const SANDBOX = "sandbox";

/**
 * A started command.
 *
 * Modelled on what a caller needs rather than on `ChildProcess`, so an implementation that is not
 * a local process — a container, another machine — can satisfy it without pretending to be one.
 */
export interface SandboxProcess {
	/** stdout and stderr interleaved, in arrival order, as the shell would have shown them. */
	onOutput(listener: (chunk: string) => void): void;
	onExit(listener: (code: number | null) => void): void;
	/** The command could not be started at all. Exit is not reported after this. */
	onError(listener: (error: Error) => void): void;
	kill(): void;
}

export interface Sandbox {
	run(command: string, options: { cwd: string; env?: Record<string, string> }): SandboxProcess;
}

/** `ctx.compaction` — how history is kept inside the model's window. */
export const COMPACTION = "compaction";

/**
 * What to do when the conversation no longer fits.
 *
 * Summarising the middle is one answer, not the answer: dropping tool output, spilling to a file
 * the agent can grep, or asking the user are all reasonable, and which is right depends on the
 * work. Returning `null` means "nothing needed", so a strategy also decides when to act.
 */
export interface CompactionStrategy {
	compact(messages: Message[], model: ModelConfig, provider: ProviderConfig): Promise<Message[] | null>;
}

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
