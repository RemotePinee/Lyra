/**
 * Session storage.
 *
 * Sessions are append-only JSONL logs. Every record carries a monotonic `seq`, which is what
 * makes cross-device sync cheap: a client that has seen up to seq N asks for everything after
 * N and replays it. Nothing is ever rewritten in place, so a phone reconnecting mid-turn
 * cannot miss or duplicate events.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentEvent } from "../agent/events.ts";
import type { Message, Usage } from "../types.ts";
import type { SessionStorage } from "./storage.ts";
import { addUsage, emptyUsage } from "../types.ts";

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
	/** Highest sequence number written. Sync clients compare against this. */
	seq: number;
}

export type SessionRecord =
	| { seq: number; ts: number; type: "meta"; meta: SessionMeta }
	| { seq: number; ts: number; type: "message"; message: Message }
	| { seq: number; ts: number; type: "event"; event: AgentEvent }
	| { seq: number; ts: number; type: "title"; title: string }
	/**
	 * Its own record type rather than a `meta` write: archiving must not touch `updatedAt`,
	 * and a `meta` record always refreshes it. Sending it through the log also means a phone
	 * syncing with `?since=N` learns the session was archived, same as any other change.
	 */
	| { seq: number; ts: number; type: "archive"; archived: boolean }
	/**
	 * Everything after `afterSeq` is void.
	 *
	 * Editing a message rewrites history — the reply it drew, and everything that followed,
	 * no longer follows from what was said. Recorded rather than achieved by rewriting the
	 * file, so the log stays append-only and a client syncing with `?since=N` finds out the
	 * same way it finds out about anything else.
	 */
	| { seq: number; ts: number; type: "truncate"; afterSeq: number };

/** `Omit` over a union collapses it into one shape; distribute so each variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A record as supplied by callers, before the store stamps `seq` and `ts`. */
export type SessionRecordInput = DistributiveOmit<SessionRecord, "seq" | "ts">;

export function deepwiseHome(): string {
	return process.env.DEEPWISE_HOME || join(homedir(), ".deepwise");
}

export function projectIdFor(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export class SessionStore implements SessionStorage {
	readonly root: string;
	/**
	 * Serializes appends per session and holds the authoritative meta.
	 *
	 * Parallel tool calls each persist their own result, and they all start from the same
	 * `meta` snapshot the caller happens to be holding. Without this, three concurrent
	 * appends all computed `seq = meta.seq + 1` and wrote three records with the same
	 * sequence number — a client syncing with `?since=N` would then silently skip two of
	 * them. The queue makes "read latest seq, increment, write" atomic per session.
	 */
	private writeQueues = new Map<string, Promise<SessionMeta>>();
	private latestMeta = new Map<string, SessionMeta>();

	constructor(root = join(deepwiseHome(), "sessions")) {
		this.root = root;
	}

	private keyFor(meta: Pick<SessionMeta, "projectId" | "id">): string {
		return `${meta.projectId}/${meta.id}`;
	}

	private dirFor(projectId: string): string {
		return join(this.root, projectId);
	}

	private fileFor(projectId: string, sessionId: string): string {
		return join(this.dirFor(projectId), `${sessionId}.jsonl`);
	}

	async create(cwd: string, modelId: string, title = "New session"): Promise<SessionMeta> {
		const projectId = projectIdFor(cwd);
		const meta: SessionMeta = {
			id: randomUUID(),
			title,
			cwd,
			projectId,
			projectName: basename(cwd) || cwd,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			modelId,
			messageCount: 0,
			usage: emptyUsage(),
			seq: 0,
		};
		await mkdir(this.dirFor(projectId), { recursive: true });
		await this.append(meta, { type: "meta", meta });
		return meta;
	}

	/** Append one record and return the updated meta, with `seq` advanced. */
	async append(meta: SessionMeta, payload: SessionRecordInput): Promise<SessionMeta> {
		const key = this.keyFor(meta);
		const previous = this.writeQueues.get(key);
		// A failed append must not poison the queue for later writes.
		const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
			this.appendExclusive(meta, payload),
		);
		this.writeQueues.set(key, next);
		return next;
	}

	private async appendExclusive(meta: SessionMeta, payload: SessionRecordInput): Promise<SessionMeta> {
		const key = this.keyFor(meta);
		// Callers may hold a stale snapshot; the store's own copy is the source of truth.
		const base = this.latestMeta.get(key) ?? meta;
		const next: SessionMeta = { ...base, seq: base.seq + 1, updatedAt: Date.now() };

		if (payload.type === "message") {
			next.messageCount = base.messageCount + 1;
			if (payload.message.role === "assistant") next.usage = addUsage(base.usage, payload.message.usage);
		}
		if (payload.type === "title") next.title = payload.title;
		if (payload.type === "archive") {
			next.archived = payload.archived;
			// Filing something away is not activity; the list stays sorted by last real use.
			next.updatedAt = base.updatedAt;
		}
		if (payload.type === "meta") {
			// A meta record carries caller-side changes such as the selected model.
			Object.assign(next, payload.meta, { seq: next.seq, updatedAt: next.updatedAt, usage: next.usage });
		}

		const record = { seq: next.seq, ts: Date.now(), ...payload } as SessionRecord;
		await mkdir(this.dirFor(meta.projectId), { recursive: true });
		await appendFile(this.fileFor(meta.projectId, meta.id), `${JSON.stringify(record)}\n`, "utf8");
		this.latestMeta.set(key, next);
		await this.writeIndex(next);
		return next;
	}

	/** Stream records, optionally only those newer than `sinceSeq`. */
	async *read(projectId: string, sessionId: string, sinceSeq = 0): AsyncGenerator<SessionRecord> {
		const file = this.fileFor(projectId, sessionId);
		if (!(await stat(file).catch(() => null))) return;

		const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
		try {
			for await (const line of rl) {
				if (!line.trim()) continue;
				let record: SessionRecord;
				try {
					record = JSON.parse(line);
				} catch {
					// A crash mid-append can leave a partial final line; skip it rather than failing the load.
					continue;
				}
				if (record.seq > sinceSeq) yield record;
			}
		} finally {
			rl.close();
		}
	}

	async messages(projectId: string, sessionId: string): Promise<Message[]> {
		const out: Message[] = [];
		for await (const record of this.read(projectId, sessionId)) {
			if (record.type === "message") out.push(record.message);
		}
		return out;
	}

	async load(
		projectId: string,
		sessionId: string,
	): Promise<{ meta: SessionMeta; messages: Message[]; compactions: number[] } | null> {
		let meta: SessionMeta | null = null;
		// Kept with their sequence numbers so a truncate record can drop the right tail.
		let entries: { seq: number; message: Message }[] = [];
		/*
		 * Where history was summarised, as a position in the transcript.
		 *
		 * Recorded at load rather than derived, because after the fact there is nothing in the
		 * messages themselves to show it happened — the summary lives only in the running
		 * session's memory, while the log keeps every original message.
		 */
		const compactions: number[] = [];
		for await (const record of this.read(projectId, sessionId)) {
			if (record.type === "meta") meta = record.meta;
			else if (record.type === "event" && record.event.type === "compacted") compactions.push(entries.length);
			else if (record.type === "message") entries.push({ seq: record.seq, message: record.message });
			else if (record.type === "title" && meta) meta.title = record.title;
			else if (record.type === "archive" && meta) meta.archived = record.archived;
			else if (record.type === "truncate") entries = entries.filter((e) => e.seq <= record.afterSeq);
			if (meta) meta.seq = record.seq;
		}
		if (!meta) return null;
		const messages = entries.map((e) => e.message);
		meta.messageCount = messages.length;
		// Seed the append queue's view so a reopened session keeps numbering where it left off.
		this.latestMeta.set(this.keyFor(meta), meta);
		return { meta, messages, compactions };
	}

	// -------------------------------------------------------------------------
	// Index: a single file listing every session, so the sidebar loads without
	// opening every JSONL log.
	// -------------------------------------------------------------------------

	private get indexPath(): string {
		return join(this.root, "index.json");
	}

	async listSessions(): Promise<SessionMeta[]> {
		const raw = await readFile(this.indexPath, "utf8").catch(() => null);
		if (!raw) return this.rebuildIndex();
		try {
			const parsed = JSON.parse(raw) as SessionMeta[];
			return Array.isArray(parsed) ? parsed.sort((a, b) => b.updatedAt - a.updatedAt) : [];
		} catch {
			return this.rebuildIndex();
		}
	}

	private async writeIndex(meta: SessionMeta): Promise<void> {
		const all = await this.listSessions();
		const next = [meta, ...all.filter((s) => s.id !== meta.id)].sort((a, b) => b.updatedAt - a.updatedAt);
		await mkdir(this.root, { recursive: true });
		// Write-then-rename so a crash cannot leave a truncated index.
		const tmp = `${this.indexPath}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
		await rename(tmp, this.indexPath);
	}

	/** Reconstruct the index by scanning every session log. Used when the index is missing or corrupt. */
	async rebuildIndex(): Promise<SessionMeta[]> {
		const metas: SessionMeta[] = [];
		const projects = await readdir(this.root, { withFileTypes: true }).catch(() => []);
		for (const project of projects) {
			if (!project.isDirectory()) continue;
			const files = await readdir(join(this.root, project.name)).catch(() => []);
			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;
				const loaded = await this.load(project.name, file.replace(/\.jsonl$/, "")).catch(() => null);
				if (loaded) metas.push(loaded.meta);
			}
		}
		metas.sort((a, b) => b.updatedAt - a.updatedAt);
		await mkdir(this.root, { recursive: true }).catch(() => {});
		await writeFile(this.indexPath, JSON.stringify(metas, null, 2), "utf8").catch(() => {});
		return metas;
	}

	/**
	 * Drop a message and everything after it.
	 *
	 * Returns the messages that survive, so the caller can reset its own in-memory copy to
	 * match without re-reading the log. Null when the index is out of range — a stale UI can
	 * ask to edit a message that has since been truncated by another client.
	 */
	async truncateFrom(
		projectId: string,
		sessionId: string,
		messageIndex: number,
	): Promise<{ meta: SessionMeta; messages: Message[] } | null> {
		const loaded = await this.load(projectId, sessionId);
		if (!loaded || messageIndex < 0 || messageIndex >= loaded.messages.length) return null;

		// The seq to keep is the one just before the record carrying the doomed message.
		let seen = 0;
		let cutoff: number | null = null;
		for await (const record of this.read(projectId, sessionId)) {
			if (record.type !== "message") continue;
			if (seen === messageIndex) {
				cutoff = record.seq - 1;
				break;
			}
			seen += 1;
		}
		if (cutoff === null) return null;

		const meta = await this.append(loaded.meta, { type: "truncate", afterSeq: cutoff });
		const messages = loaded.messages.slice(0, messageIndex);
		// The index tracks message count; a truncate is the one write that lowers it.
		const corrected = await this.append(meta, { type: "meta", meta: { ...meta, messageCount: messages.length } });
		return { meta: { ...corrected, messageCount: messages.length }, messages };
	}

	/**
	 * Move a session in or out of the archive.
	 *
	 * Returns null when the session is not in the index — a stale sidebar can ask about one
	 * that has since been deleted, and that is not worth throwing over.
	 */
	async setArchived(projectId: string, sessionId: string, archived: boolean): Promise<SessionMeta | null> {
		const current = (await this.listSessions()).find((s) => s.projectId === projectId && s.id === sessionId);
		if (!current) return null;
		return this.append(current, { type: "archive", archived });
	}

	async delete(projectId: string, sessionId: string): Promise<void> {
		await unlink(this.fileFor(projectId, sessionId)).catch(() => {});
		const all = await this.listSessions();
		await mkdir(this.root, { recursive: true });
		await writeFile(this.indexPath, JSON.stringify(all.filter((s) => s.id !== sessionId), null, 2), "utf8");
	}

	/**
	 * Drop sessions that were created but never used.
	 *
	 * A session with no messages holds nothing — no transcript, no usage, not even a title.
	 * They accumulate from any path that reserves a session up front and then does not send
	 * anything: a scheduled task that failed to start, a client that navigated away. Run at
	 * launch, this keeps that debris from filling the sidebar.
	 *
	 * `minAgeMs` protects sessions that were only just created: another client may be mid-way
	 * through its own "new session, about to send" sequence, and deleting that out from under
	 * it would break a live conversation before it starts.
	 */
	async pruneEmpty(minAgeMs = 5 * 60_000): Promise<number> {
		const cutoff = Date.now() - minAgeMs;
		const empty = (await this.listSessions()).filter((s) => s.messageCount === 0 && s.createdAt < cutoff);
		if (empty.length === 0) return 0;
		await this.deleteMany(empty.map((s) => ({ projectId: s.projectId, id: s.id })));
		return empty.length;
	}

	/** Delete several sessions with a single index rewrite, for "empty the archive". */
	async deleteMany(targets: { projectId: string; id: string }[]): Promise<void> {
		await Promise.all(targets.map((t) => unlink(this.fileFor(t.projectId, t.id)).catch(() => {})));
		const gone = new Set(targets.map((t) => t.id));
		const all = await this.listSessions();
		await mkdir(this.root, { recursive: true });
		await writeFile(this.indexPath, JSON.stringify(all.filter((s) => !gone.has(s.id)), null, 2), "utf8");
	}
}
