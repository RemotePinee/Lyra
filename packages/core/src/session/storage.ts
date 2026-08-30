/**
 * What a session store has to be able to do.
 *
 * Extracted from the class rather than designed ahead of it: the JSONL store came first, and this
 * is the shape it turned out to have. Naming it is what lets a session be kept somewhere else —
 * a database, a server, a phone's local cache — without the runtime knowing which.
 *
 * The append-only contract is part of the interface, not an implementation detail. Callers rely on
 * `append` never rewriting history and on `read` replaying it in order; a store that compacted its
 * own file in place would satisfy the types and break every client syncing with `?since=N`.
 */

import type { Message } from "../types.ts";
import type { Boundary, SessionMeta, SessionRecord, SessionRecordInput } from "./store.ts";

export interface ReadSessionOptions {
	sinceSeq?: number;
	beforeSeq?: number;
	limit?: number;
}

export interface SessionStorage {
	create(cwd: string, modelId: string, title?: string): Promise<SessionMeta>;
	/** Add one record and return the meta it produced. Never rewrites what is already there. */
	append(meta: SessionMeta, payload: SessionRecordInput): Promise<SessionMeta>;
	read(projectId: string, sessionId: string, options?: number | ReadSessionOptions): AsyncGenerator<SessionRecord>;
	messages(projectId: string, sessionId: string): Promise<Message[]>;
	load(
		projectId: string,
		sessionId: string,
	): Promise<{ meta: SessionMeta; messages: Message[]; compactions: number[]; compaction: Boundary | null } | null>;
	listSessions(): Promise<SessionMeta[]>;
	rebuildIndex(): Promise<SessionMeta[]>;
	truncateFrom(
		projectId: string,
		sessionId: string,
		messageIndex: number,
	): Promise<{ meta: SessionMeta; messages: Message[] } | null>;
	setArchived(projectId: string, sessionId: string, archived: boolean): Promise<SessionMeta | null>;
	delete(projectId: string, sessionId: string): Promise<void>;
	deleteMany(targets: { projectId: string; id: string }[]): Promise<void>;
	pruneEmpty(minAgeMs?: number): Promise<number>;
}
