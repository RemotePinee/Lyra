/**
 * Wire types shared with the desktop sync server.
 *
 * Duplicated here rather than imported from @lyra/core: Metro would have to bundle a
 * package full of `node:` imports, and the mobile client only ever sees this JSON subset.
 */

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type UserContent = TextContent | ImageContent;
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: { total: number };
}

export interface UserMessage {
	role: "user";
	content: UserContent[];
	timestamp: number;
	synthetic?: boolean;
	/**
	 * Set when the desktop's side chat dispatched this rather than a person typing it.
	 *
	 * The side chat does not sync — it is memory-only on the machine it runs on — but the work
	 * it hands to a session does, and arrives here looking like something you wrote.
	 */
	origin?: "side-chat";
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	model: string;
	usage: Usage;
	stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: UserContent[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface SessionMeta {
	id: string;
	title: string;
	cwd: string;
	projectId: string;
	projectName: string;
	createdAt: number;
	updatedAt: number;
	modelId: string;
	messageCount: number;
	usage: Usage;
	archived?: boolean;
	seq: number;
}

export type SessionRecord =
	| { seq: number; ts: number; type: "meta"; meta: SessionMeta }
	| { seq: number; ts: number; type: "archive"; archived: boolean }
	| { seq: number; ts: number; type: "truncate"; afterSeq: number }
	| { seq: number; ts: number; type: "message"; message: Message }
	| { seq: number; ts: number; type: "event"; event: AgentEvent }
	| { seq: number; ts: number; type: "title"; title: string };

export type AgentEvent =
	| { type: "agent_start"; sessionId: string }
	| { type: "turn_start"; turn: number }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: AssistantMessage }
	| { type: "message_end"; message: Message }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown>; summary: string }
	| { type: "tool_update"; toolCallId: string; partial: { content: UserContent[] } }
	| {
			type: "tool_end";
			toolCallId: string;
			toolName: string;
			result: { content: UserContent[]; details?: unknown };
			isError: boolean;
	  }
	| { type: "approval_request"; requestId: string; toolCallId: string; kind: string; title: string; detail: string }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "agent_end"; reason: string; error?: string }
	| { type: "notice"; level: "info" | "warn" | "error"; message: string }
	| { type: "title"; title: string }
	| { type: "rewound"; messageCount: number };

interface RemoteModel {
	id: string;
	name: string;
	provider: string;
	api: string;
}

export interface RemoteSettings {
	permissionMode: string;
	thinking: string;
	defaultModelId: string | null;
	projects: { id: string; name: string; path: string; pinned: boolean; lastOpenedAt: number }[];
	models: RemoteModel[];
}
