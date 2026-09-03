/**
 * What was actually spent, by day and by model.
 *
 * The session index already carries a total per conversation, and that is the wrong shape for
 * every question worth asking: it is stamped with `updatedAt`, so a refactor spread over three
 * days lands entirely on the third, and it has no idea which model did the spending — which is
 * the one thing you want to know when four relays are configured and one of them is expensive.
 *
 * So the logs themselves are read. They are append-only, which makes that cheap to keep doing:
 * a file whose size has grown is read from where the last scan stopped rather than from the top,
 * and one that has not changed at all is not opened. First pass over a real home here — 264MB
 * across 185 conversations — takes a couple of seconds; every pass after it is a few kilobytes.
 */

import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { lyraHome } from "@lyra/core";

/** One day's spend on one model. The unit the page slices every way. */
export interface UsageBucket {
	/** `YYYY-MM-DD`, local. A turn at 23:00 belongs to the day you had it. */
	day: string;
	/** `${provider}/${model}` as the message recorded it — the wire names, not the local id. */
	key: string;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Replies, which is what token counts belong to. */
	replies: number;
}

/** One day, across every model. */
export interface UsageDay {
	day: string;
	/** Conversations that said or heard anything that day. */
	sessions: number;
	/** Messages on both sides — what "how much did I talk to it" means. */
	messages: number;
}

export interface UsageScan {
	days: UsageDay[];
	buckets: UsageBucket[];
	/** How many logs were read this time, and how many were answered from the cache. */
	scanned: number;
	cached: number;
	tookMs: number;
}

/** What one log contributed, kept so an unchanged file is never opened again. */
interface FileEntry {
	mtimeMs: number;
	size: number;
	buckets: UsageBucket[];
	/** Messages per day in this one conversation; its presence is also its "active that day". */
	days: Record<string, number>;
}

type Cache = Record<string, FileEntry>;

/** Local date key, deliberately not ISO/UTC. Mirrors `dayKey` in the settings page. */
function dayKey(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function emptyEntry(mtimeMs: number, size: number): FileEntry {
	return { mtimeMs, size, buckets: [], days: {} };
}

function bucketFor(entry: FileEntry, day: string, key: string, provider: string, model: string): UsageBucket {
	const found = entry.buckets.find((each) => each.day === day && each.key === key);
	if (found) return found;
	const fresh: UsageBucket = {
		day,
		key,
		provider,
		model,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		replies: 0,
	};
	entry.buckets.push(fresh);
	return fresh;
}

/**
 * Read one log, from `entry.size` onwards.
 *
 * Records are whole lines appended atomically, so the previous size is always a line boundary —
 * but a line that fails to parse is skipped rather than thrown on, because a log truncated by a
 * crash mid-write is a thing that happens and losing one turn's numbers is not worth losing the
 * page over.
 */
async function readLog(path: string, entry: FileEntry, size: number): Promise<void> {
	const from = entry.size;
	if (size <= from) return;

	const stream = createReadStream(path, { encoding: "utf8", start: from });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			// Cheaper than parsing: most records in a busy log are events, not messages.
			if (!line.includes('"type":"message"')) continue;
			let record: { type?: string; message?: Record<string, unknown> };
			try {
				record = JSON.parse(line) as typeof record;
			} catch {
				continue;
			}
			const message = record.type === "message" ? record.message : undefined;
			if (!message) continue;

			const at = typeof message.timestamp === "number" ? message.timestamp : 0;
			if (!at) continue;
			const day = dayKey(at);
			entry.days[day] = (entry.days[day] ?? 0) + 1;

			if (message.role !== "assistant") continue;
			const usage = (message.usage ?? {}) as Record<string, number | undefined> & {
				cost?: { total?: number };
			};
			const provider = String(message.provider ?? "unknown");
			const model = String(message.model ?? "unknown");
			const bucket = bucketFor(entry, day, `${provider}/${model}`, provider, model);
			bucket.input += usage.input ?? 0;
			bucket.output += usage.output ?? 0;
			bucket.cacheRead += usage.cacheRead ?? 0;
			bucket.cacheWrite += usage.cacheWrite ?? 0;
			bucket.cost += usage.cost?.total ?? 0;
			bucket.replies += 1;
		}
	} finally {
		lines.close();
		stream.close();
	}
	entry.size = size;
}

/** Every session log under `~/.lyra/sessions`, as `projectId/session.jsonl`. */
async function logPaths(root: string): Promise<string[]> {
	const out: string[] = [];
	const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const files = await readdir(join(root, project.name)).catch(() => []);
		for (const file of files) {
			if (file.endsWith(".jsonl")) out.push(join(project.name, file));
		}
	}
	return out;
}

/**
 * Everything spent, by day and by model.
 *
 * The cache is an optimisation and never a source of truth: a file whose mtime or size disagrees
 * with what was recorded is re-read from scratch — including one that shrank, which means it was
 * rewritten rather than appended to and nothing about the old numbers can be trusted.
 */
export async function scanUsage(home = lyraHome()): Promise<UsageScan> {
	const started = Date.now();
	const root = join(home, "sessions");
	const cachePath = join(home, "usage-cache.json");

	const cache: Cache = await readFile(cachePath, "utf8")
		.then((raw) => JSON.parse(raw) as Cache)
		.catch(() => ({}));

	const next: Cache = {};
	const days = new Map<string, UsageDay>();
	const totals = new Map<string, UsageBucket>();
	let scanned = 0;
	let cached = 0;

	for (const relative of await logPaths(root)) {
		const path = join(root, relative);
		const info = await stat(path).catch(() => null);
		if (!info) continue;

		const known = cache[relative];
		/*
		 * Three cases, and the middle one is the whole reason this is fast.
		 *
		 * Untouched: not opened at all. Grown: read from where the last pass stopped, because the
		 * log is append-only and the previous size is a line boundary. Anything else — smaller,
		 * or the same size under a different mtime — means it was rewritten rather than appended
		 * to, and nothing recorded about it can be trusted, so it is read from the top.
		 */
		const untouched = known !== undefined && known.mtimeMs === info.mtimeMs && known.size === info.size;
		const grown = known !== undefined && !untouched && info.size > known.size;
		const entry = untouched || grown ? { ...known, buckets: known.buckets.map((b) => ({ ...b })), days: { ...known.days } } : emptyEntry(info.mtimeMs, 0);

		if (untouched) cached += 1;
		else {
			await readLog(path, entry, info.size);
			scanned += 1;
		}
		entry.mtimeMs = info.mtimeMs;
		entry.size = info.size;
		next[relative] = entry;

		for (const [day, messages] of Object.entries(entry.days)) {
			const seen = days.get(day) ?? { day, sessions: 0, messages: 0 };
			// One log is one conversation, so its presence on a day is one active conversation.
			seen.sessions += 1;
			seen.messages += messages;
			days.set(day, seen);
		}
		for (const bucket of entry.buckets) {
			const id = `${bucket.day} ${bucket.key}`;
			const seen = totals.get(id);
			if (!seen) {
				totals.set(id, { ...bucket });
				continue;
			}
			seen.input += bucket.input;
			seen.output += bucket.output;
			seen.cacheRead += bucket.cacheRead;
			seen.cacheWrite += bucket.cacheWrite;
			seen.cost += bucket.cost;
			seen.replies += bucket.replies;
		}
	}

	// Best effort: a cache that cannot be written costs a re-scan, which is not worth failing over.
	await writeFile(cachePath, JSON.stringify(next), "utf8").catch(() => {});

	return {
		days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
		buckets: [...totals.values()].sort((a, b) => a.day.localeCompare(b.day)),
		scanned,
		cached,
		tookMs: Date.now() - started,
	};
}
