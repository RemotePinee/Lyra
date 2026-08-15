/**
 * One thing that happened, as the trajectory shows it.
 *
 * The session log is written for machines: append-only records keyed by sequence, some of which
 * carry three separate things at once (a reply with thinking, text and two tool calls is one
 * record). A trajectory is the same stream read for a person — one entry per thing that happened,
 * each labelled with where it came from.
 *
 * `seq` is the record it came from, so an entry can always be traced back, and several entries
 * sharing a `seq` is normal and meaningful: they arrived together.
 */

export type Source =
	/** The instructions the model was given. */
	| "system"
	/** What was injected around the messages for this turn: tools, skills. */
	| "context"
	| "user"
	/** The model's reasoning, when it exposes any. */
	| "thinking"
	| "assistant"
	| "tool-call"
	| "tool-result"
	/** A nested agent being dispatched, and what it reported back. */
	| "subagent"
	/** History being summarised to fit the window. */
	| "compaction";

export interface Entry {
	/** The log record this came from. Not unique: one record can produce several entries. */
	seq: number;
	ts: number;
	source: Source;
	/** One line, for the list. */
	summary: string;
	/** Everything, for the detail pane. */
	detail: string;
	/** Ties a tool result back to its call, and a sub-agent's answer to its dispatch. */
	correlationId?: string;
	/**
	 * The shell command this entry is about, when it is about one.
	 *
	 * Carried separately from `detail` because a command is the thing you look for first when a
	 * step did something unexpected, and finding it inside a JSON string — escaped, on one line,
	 * among other arguments — is reading around the syntax rather than reading the command.
	 */
	command?: string;
}

/** Shown as filter chips, in the order a turn actually happens. */
export const SOURCE_ORDER: Source[] = [
	"system",
	"context",
	"user",
	"thinking",
	"assistant",
	"tool-call",
	"tool-result",
	"subagent",
	"compaction",
];

export const SOURCE_LABEL: Record<Source, string> = {
	system: "系统提示词",
	context: "上下文注入",
	user: "用户消息",
	thinking: "思维链",
	assistant: "模型回复",
	"tool-call": "工具调用",
	"tool-result": "工具结果",
	subagent: "子 Agent",
	compaction: "上下文压缩",
};
