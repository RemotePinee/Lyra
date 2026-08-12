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
	| { type: "agent_end"; reason: "done" | "aborted" | "error" | "max_turns"; error?: string }
	| { type: "notice"; level: "info" | "warn" | "error"; message: string }
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
