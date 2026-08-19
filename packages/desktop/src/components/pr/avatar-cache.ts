/**
 * Every face the pane has fetched, in one store it all shares.
 *
 * A picture per row is a small thing that gets expensive in a specific way: the component asked
 * for its own on mount, so scrolling a list of sixty was sixty IPC round trips, the same three
 * authors fetched over and over, and a visible flash of the fallback initial on every remount even
 * though the answer had been sitting in the main process the whole time.
 *
 * Three moves fix all of it, and none of them are about the picture:
 *
 *   - **one store, module-scoped**, so the answer outlives the component that asked;
 *   - **one request per frame**, since a list arrives all at once and thirty names in one call is
 *     one round trip instead of thirty;
 *   - **kept in `localStorage`**, so the second launch draws the faces in the first frame rather
 *     than a beat later. They are a few KB each and they do not change.
 */

import { useEffect, useSyncExternalStore } from "react";

const KEY = "lyra.avatars.v1";

/** Roughly 4KB each at this size. Eighty covers every author a triage session sees. */
const LIMIT = 80;

/**
 * Long enough for one list to arrive, short enough to be invisible.
 *
 * The rows of a refreshed list mount in the same frame, so anything above zero collects all of
 * them; anything a person could notice would show the fallback initial first and then swap it.
 */
const BATCH_MS = 16;

/**
 * How long before a face that did not arrive is asked about again.
 *
 * Only successes are kept here; a miss leaves nothing behind but the timestamp below, so the next
 * refresh of the list picks it up. Longer than one poll and shorter than a session: a picture that
 * timed out on a cold start comes back on its own, and an account that genuinely has none is not
 * re-fetched by every row of every refresh.
 */
const RETRY_MS = 60_000;

const faces = new Map<string, string>(restore());
/** When each login was last asked about, hit or miss — the whole of the retry policy. */
const asked = new Map<string, number>();
const listeners = new Set<() => void>();

let queued: Map<string, string | null> | null = null;
let timer = 0;

function restore(): [string, string][] {
	try {
		const raw = localStorage.getItem(KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : null;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is [string, string] =>
				Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
		);
	} catch {
		return [];
	}
}

function persist(): void {
	try {
		localStorage.setItem(KEY, JSON.stringify([...faces].slice(-LIMIT)));
	} catch {
		// A full or disabled store: the faces still work, they just arrive a beat later next time.
	}
}

function want(login: string, url?: string | null): void {
	if (!login || faces.has(login)) return;
	if (Date.now() - (asked.get(login) ?? 0) < RETRY_MS) return;
	queued ??= new Map();
	if (queued.has(login)) return;
	asked.set(login, Date.now());
	queued.set(login, url ?? null);
	if (!timer) timer = window.setTimeout(() => void flush(), BATCH_MS);
}

async function flush(): Promise<void> {
	timer = 0;
	const batch = queued;
	queued = null;
	if (!batch?.size) return;

	const answer = await window.lyra.git.avatars([...batch].map(([login, url]) => ({ login, url }))).catch(() => null);
	if (!answer) return;

	// Only what arrived is recorded. A miss leaves the login absent, which — behind the retry
	// window above — is what lets a later refresh pick it up instead of the first bad second at
	// launch deciding the whole session.
	let changed = false;
	for (const login of batch.keys()) {
		const value = answer[login];
		if (typeof value === "string" && faces.get(login) !== value) {
			faces.set(login, value);
			changed = true;
		}
	}
	if (!changed) return;
	persist();
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Ask for every face a list is about to draw, before any of it is drawn.
 *
 * Called when the list itself arrives rather than when a row mounts, so the pictures for rows
 * below the fold are already in hand by the time scrolling reaches them.
 */
export function prefetchAvatars(people: { author: string; avatarUrl?: string | null }[]): void {
	for (const person of people) want(person.author, person.avatarUrl);
}

/** This account's picture, or null while there is not one — which is also the resting state. */
export function useAvatar(login: string, url?: string | null): string | null {
	const src = useSyncExternalStore(
		subscribe,
		() => faces.get(login) ?? null,
	);

	useEffect(() => {
		want(login, url);
	}, [login, url]);

	return src;
}
