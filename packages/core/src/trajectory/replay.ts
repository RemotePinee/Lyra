/**
 * Walking the event stream forwards.
 *
 * "What had happened by sequence N" is the question underneath resuming, forking and replaying, so
 * it is answered once, here. Resuming asks for the end of the stream; forking asks for a point in
 * the middle; replaying asks for every point in turn.
 *
 * Truncation is applied as it is met rather than pre-scanned, because that is what it means: a
 * record that voids the tail behind it, in the order the file was written.
 */

import type { SessionRecord, SessionStore } from "../session/store.ts";
import type { Message } from "../types.ts";

/** The messages a session held at a given point. Pass `Infinity` for "all of it". */
export async function messagesUpTo(
	store: Pick<SessionStore, "read">,
	projectId: string,
	sessionId: string,
	seq: number,
): Promise<Message[]> {
	const kept: { seq: number; message: Message }[] = [];
	for await (const record of store.read(projectId, sessionId)) {
		if (record.seq > seq) break;
		if (record.type === "truncate") {
			const cutoff = record.afterSeq;
			while (kept.length > 0 && kept[kept.length - 1].seq > cutoff) kept.pop();
			continue;
		}
		if (record.type === "message") kept.push({ seq: record.seq, message: record.message });
	}
	return kept.map((entry) => entry.message);
}

/**
 * Every record in order, as steps.
 *
 * A generator rather than an array: a replay is watched one step at a time, and a long session's
 * records are the one thing in this app that genuinely does not fit comfortably in memory.
 */
export async function* replaySession(
	store: Pick<SessionStore, "read">,
	projectId: string,
	sessionId: string,
	sinceSeq = 0,
): AsyncGenerator<SessionRecord> {
	for await (const record of store.read(projectId, sessionId, sinceSeq)) yield record;
}
