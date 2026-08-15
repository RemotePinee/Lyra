/**
 * Reading the session log as a trajectory.
 *
 * One pass over the append-only records, turning each into the entries a person would recognise.
 * The interesting part is that this is the *only* reader: resuming, forking and replaying all go
 * through it, so there is one answer to "what happened" rather than three that can disagree.
 *
 * `truncate` records are honoured here rather than by rewriting the file — history is never edited,
 * so a trajectory has to know that a tail was voided and leave it out.
 */

import type { AgentEvent } from "../agent/events.ts";
import type { SessionRecord } from "../session/store.ts";
import type { Message } from "../types.ts";
import type { Entry } from "./types.ts";

export interface TrajectorySource {
	read(projectId: string, sessionId: string, sinceSeq?: number): AsyncGenerator<SessionRecord>;
}

export async function readTrajectory(
	store: TrajectorySource,
	projectId: string,
	sessionId: string,
): Promise<Entry[]> {
	const entries: Entry[] = [];
	for await (const record of store.read(projectId, sessionId)) {
		if (record.type === "truncate") {
			// Everything after the cut no longer follows from what was said.
			const cutoff = record.afterSeq;
			for (let i = entries.length - 1; i >= 0 && entries[i].seq > cutoff; i--) entries.pop();
			continue;
		}
		entries.push(...entriesFor(record));
	}
	return entries;
}

/** One record, as the one or more things it actually records. */
function entriesFor(record: SessionRecord): Entry[] {
	if (record.type === "message") return fromMessage(record.seq, record.ts, record.message);
	if (record.type === "event") return fromEvent(record.seq, record.ts, record.event);
	return [];
}

function fromMessage(seq: number, ts: number, message: Message): Entry[] {
	if (message.role === "user") {
		const text = textOf(message.content);
		return [{ seq, ts, source: "user", summary: firstLine(text), detail: text }];
	}

	if (message.role === "toolResult") {
		const text = textOf(message.content);
		return [
			{
				seq,
				ts,
				source: "tool-result",
				summary: firstLine(text) || "(无输出)",
				detail: text,
				correlationId: message.toolCallId,
			},
		];
	}

	if (message.role !== "assistant") return [];

	/*
	 * An assistant message is up to three different things at once.
	 *
	 * Splitting them is the whole point of a by-source view: "show me only the reasoning" cannot
	 * work while reasoning is a field on an entry that is labelled as a reply.
	 */
	const out: Entry[] = [];
	for (const part of message.content) {
		if (part.type === "thinking" && part.thinking.trim()) {
			out.push({ seq, ts, source: "thinking", summary: firstLine(part.thinking), detail: part.thinking });
		}
		if (part.type === "text" && part.text.trim()) {
			out.push({ seq, ts, source: "assistant", summary: firstLine(part.text), detail: part.text });
		}
		if (part.type === "toolCall") {
			const args = JSON.stringify(part.arguments, null, 2);
			out.push({
				seq,
				ts,
				source: "tool-call",
				summary: `${part.name} ${firstLine(compact(part.arguments))}`.trim(),
				detail: `${part.name}\n\n${args}`,
				correlationId: part.id,
			});
		}
	}
	return out;
}

function fromEvent(seq: number, ts: number, event: AgentEvent): Entry[] {
	if (event.type === "context") {
		return [
			{
				seq,
				ts,
				source: "system",
				summary: `系统提示词 ${event.systemPrompt.length} 字`,
				detail: event.systemPrompt,
			},
			{
				seq,
				ts,
				source: "context",
				summary: `工具 ${event.tools.length} 个、技能 ${event.skills.length} 个`,
				detail: `工具：\n${event.tools.join("\n")}\n\n技能：\n${event.skills.join("\n") || "（无）"}`,
			},
		];
	}

	if (event.type === "subagent") {
		return [
			{
				seq,
				ts,
				source: "subagent",
				summary: `派发 ${event.agent}：${event.description}`,
				detail: `agent: ${event.agent}\n工具: ${event.tools.join(", ")}\n\n${event.prompt}`,
				correlationId: event.id,
			},
		];
	}

	if (event.type === "subagent_done") {
		return [
			{
				seq,
				ts,
				source: "subagent",
				summary: `子 Agent 回报（${event.steps.length} 步）`,
				detail: `步骤：\n${event.steps.join("\n")}\n\n回答：\n${event.answer}`,
				correlationId: event.id,
			},
		];
	}

	if (event.type === "compacted") {
		return [
			{
				seq,
				ts,
				source: "compaction",
				summary: `历史压缩：${event.before} → ${event.after} 条`,
				detail: `压缩前 ${event.before} 条消息，压缩后 ${event.after} 条。`,
			},
		];
	}

	return [];
}

function textOf(content: { type: string; text?: string }[]): string {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

function firstLine(text: string): string {
	const line = text.split("\n").find((candidate) => candidate.trim());
	return (line ?? "").trim().slice(0, 120);
}

/** Arguments on one line, for the summary. */
function compact(args: Record<string, unknown>): string {
	const parts = Object.entries(args).map(([key, value]) => `${key}=${String(value).slice(0, 40)}`);
	return parts.join(" ").slice(0, 100);
}
