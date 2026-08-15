import type { AssistantMessage, Message, StreamEvent, ToolResult, ToolResultMessage } from "../types.ts";

/**
 * Everything the UI needs to render a live session. The desktop renderer, the mobile app
 * and the session log all consume this one event type.
 */
export type AgentEvent =
	| { type: "agent_start"; sessionId: string }
	| { type: "turn_start"; turn: number }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: AssistantMessage; delta: StreamEvent }
	| { type: "message_end"; message: Message }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown>; summary: string }
	| { type: "tool_update"; toolCallId: string; partial: ToolResult }
	| { type: "tool_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
	| { type: "approval_request"; requestId: string; toolCallId: string; kind: string; title: string; detail: string }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	/** `stalled`: the turn kept making the same call for the same answer and was stopped. */
	| { type: "agent_end"; reason: "done" | "aborted" | "error" | "max_turns" | "stalled"; error?: string }
	| { type: "notice"; level: "info" | "warn" | "error"; message: string }
	/**
	 * What the model was given at the start of a turn.
	 *
	 * The transcript records what the model said; this records what it was told — the system
	 * prompt, the tools it could reach, the skills it knew about. Without it a session cannot be
	 * read back honestly: the same messages produce different behaviour under a different prompt
	 * or a different tool set, and nothing in the log would say which one was in force.
	 *
	 * Written when it changes rather than every turn, because it rarely changes and a log that
	 * repeats itself is one nobody reads.
	 */
	| { type: "context"; systemPrompt: string; tools: string[]; skills: string[] }
	/**
	 * A sub-agent was dispatched, and what came back.
	 *
	 * The parent's transcript shows the `task` call and the paragraph it returned — which is the
	 * point of delegation, and also the problem: the work itself happened somewhere the log could
	 * not see. Recording the dispatch (which definition, which tools, what it was asked) and the
	 * steps it took makes a delegated turn as readable afterwards as one done in the open.
	 *
	 * Steps are summaries, not transcripts. A sub-agent exists so its forty file reads stay out of
	 * the parent context; copying them into the parent log would give that back with interest.
	 */
	| { type: "subagent"; id: string; agent: string; description: string; prompt: string; tools: string[] }
	| { type: "subagent_done"; id: string; steps: string[]; answer: string }
	/**
	 * History was summarised to fit the window.
	 *
	 * Its own event rather than a notice, because it is a fact about the conversation that
	 * outlives the moment: everything before it is a summary now, and someone reading the
	 * transcript later needs to know that. Notices are transient by design and this is not.
	 */
	| { type: "compacted"; before: number; after: number }
	/**
	 * The connection dropped and the turn is being retried.
	 *
	 * Its own event rather than a notice, because it describes what this turn is doing right now
	 * — the same class of fact as "thinking" or "running a tool" — and belongs beside the turn
	 * rather than in the corner of the window with things that outlive it. It also expires on its
	 * own: once the turn is over, whether it was retried is history nobody needs.
	 */
	| { type: "retry"; attempt: number; delayMs: number; reason: string }
	/**
	 * The session got its name from the first prompt.
	 *
	 * Announced rather than left for the next list refresh: the title is set the instant the
	 * first message lands, but clients only re-read the session index when a turn ends, so the
	 * sidebar sat on "New session" for the whole first reply.
	 */
	| { type: "title"; title: string }
	/**
	 * History was rewritten: keep the first `messageCount` messages and drop the rest.
	 *
	 * Sent when a message is edited. Clients cannot infer this from the messages that follow —
	 * the replacement looks like an ordinary new message — so the discard is announced.
	 */
	| { type: "rewound"; messageCount: number }
	/**
	 * The task queue changed.
	 *
	 * Carries the whole queue rather than a delta. It is a handful of short entries, and a
	 * client that missed one event would otherwise hold a queue that is quietly wrong — the
	 * one thing a "what is it going to do next" list must never be.
	 */
	| { type: "tasks"; tasks: QueuedTask[] };

/**
 * Work handed to a session from somewhere other than its own composer.
 *
 * The side chat has no tools: it cannot touch the workspace itself. When it decides something
 * needs doing, it queues it here and the main session runs it after whatever it is already
 * doing. One executor per workspace, so two agents can never fight over the same files.
 */
export interface QueuedTask {
	id: string;
	/** What to do, phrased as an instruction — this becomes the prompt verbatim. */
	text: string;
	origin: "side-chat";
	status: "queued" | "running" | "done" | "failed" | "cancelled";
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Why it failed, when it did. */
	error?: string;
}

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
