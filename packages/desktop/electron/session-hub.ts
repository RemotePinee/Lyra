/**
 * The live sessions, and how their events get out.
 *
 * A session is expensive: it owns MCP servers as real child processes and a headless browser. So
 * this is also where they are kept to a bounded number and evicted by recency — an afternoon of
 * moving between conversations should not leave a dozen sets of processes running.
 *
 * Everything the rest of the main process needs from a session goes through here, which is what
 * keeps the map from being reachable — and therefore mutable — from six different files.
 */

import { AgentSession, type AgentEvent, type SessionStorage, type Settings, type SideChat } from "@lyra/core";
import type { BrowserWindow } from "electron";
import { createBrowserTools } from "./browser-tools.ts";
import type { SessionSnapshot } from "./ipc-types.ts";
import { ensureSessionWorkspace } from "./scratch.ts";

export interface HubDeps {
	store(): SessionStorage;
	settings(): Settings;
	window(): BrowserWindow | null;
	/** Events also go to connected phones, when the sync server is up. */
	sync?(): { broadcast(sessionId: string, event: AgentEvent): void } | null;
}

let deps: HubDeps = {
	store: () => {
		throw new Error("session hub used before configure()");
	},
	settings: () => {
		throw new Error("session hub used before configure()");
	},
	window: () => null,
};

export function configureHub(next: HubDeps): void {
	deps = next;
}

export const sessions = new Map<string, AgentSession>();
/** Disposers for each session's browser tools, keyed the same way. */
export const browsers = new Map<string, () => void>();
/** Side chats, one per session, built on first use and dropped with the session. */
export const sideChats = new Map<string, SideChat>();


export function broadcast(sessionId: string, event: AgentEvent): void {
	const win = deps.window();
	if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
		win.webContents.send("agent:event", { sessionId, event });
	}
	deps.sync?.()?.broadcast(sessionId, event);
}

/**
 * Side-chat events go to this window and nowhere else.
 *
 * Not to the sync server: the side chat is memory-only and belongs to the machine you are
 * sitting at. A phone replaying the session log would have no conversation to attach these to.
 */
export function broadcastSideChat(sessionId: string, event: AgentEvent): void {
	const win = deps.window();
	if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
		win.webContents.send("sidechat:event", { sessionId, event });
	}
}

export async function getOrCreateSession(cwd: string, _modelId: string): Promise<AgentSession> {
	// A project-less conversation runs in a directory under the app's home, and that directory can
	// be gone — swept by a version of this app that used to, or removed by hand. Put it back before
	// a session is built around a working directory that is not there.
	await ensureSessionWorkspace(cwd).catch(() => false);
	const browser = createBrowserTools();
	// `emit` closes over `session`, which is only ever invoked after `initialize()` has
	// assigned `meta`, so the self-reference is safe — but it needs an explicit type.
	const session: AgentSession = new AgentSession({
		cwd,
		settings: deps.settings(),
		store: deps.store(),
		extraTools: browser.tools,
		emit: (event: AgentEvent) => broadcast(session.meta.id, event),
	});
	await session.initialize();
	sessions.set(session.meta.id, session);
	browsers.set(session.meta.id, browser.dispose);
	return session;
}

/**
 * How many sessions stay warm.
 *
 * Each one owns its MCP servers — real child processes — plus a headless browser, so an
 * unbounded map meant an afternoon of browsing left a dozen sets of them running. Three keeps
 * the conversations you are actually moving between instant without hoarding processes.
 */
const MAX_LIVE_SESSIONS = 3;

/** Move a session to the end of the map, which is the recency order eviction walks. */
export function touchSession(sessionId: string): void {
	const session = sessions.get(sessionId);
	if (!session) return;
	sessions.delete(sessionId);
	sessions.set(sessionId, session);
}

export async function snapshot(session: AgentSession): Promise<SessionSnapshot> {
	return {
		meta: session.meta,
		messages: session.messages,
		running: session.running,
		pendingApprovals: session.listPendingApprovals().map(({ id, request }) => ({
			id,
			kind: request.kind,
			title: request.title,
			detail: request.detail,
		})),
	};
}

/** Tear down a live session's agent, MCP servers and browser. Safe to call for unknown ids. */
export async function disposeSession(sessionId: string): Promise<void> {
	await sessions.get(sessionId)?.dispose();
	browsers.get(sessionId)?.();
	browsers.delete(sessionId);
	// A side chat reads its session's live message list; without the session it has nothing
	// to read, so it goes at the same time.
	sideChats.get(sessionId)?.abort();
	sideChats.delete(sessionId);
	sessions.delete(sessionId);
}

export async function activateSession(projectId: string, sessionId: string): Promise<AgentSession | null> {
	const existing = sessions.get(sessionId);
	if (existing) {
		touchSession(sessionId);
		return existing;
	}

	const loaded = await deps.store().load(projectId, sessionId);
	if (!loaded) return null;
	// Same as `getOrCreateSession`: a stored conversation's directory may not have survived.
	await ensureSessionWorkspace(loaded.meta.cwd).catch(() => false);
	const browser = createBrowserTools();
	const session = new AgentSession({
		cwd: loaded.meta.cwd,
		settings: deps.settings(),
		store: deps.store(),
		meta: loaded.meta,
		extraTools: browser.tools,
		emit: (event) => broadcast(sessionId, event),
	});
	session.restore(loaded.messages, loaded.compaction);
	await session.initialize();
	sessions.set(sessionId, session);
	browsers.set(sessionId, browser.dispose);
	await evictStaleSessions(sessionId);
	return session;
}

/** Retire the least recently used sessions, never one mid-turn and never the current one. */
async function evictStaleSessions(keep: string): Promise<void> {
	// Snapshotted with `entries()`, not spread: this loop deletes from the map as it goes.
	for (const [id, session] of Array.from(sessions.entries())) {
		if (sessions.size <= MAX_LIVE_SESSIONS) break;
		// An open side chat is a conversation in progress, same as a running turn — evicting
		// its session would silently throw that conversation away.
		if (id === keep || session.running || sideChats.has(id)) continue;
		await disposeSession(id);
	}
}

/**
 * The live session for an id, activating it from disk if it is not warm yet.
 *
 * The one entry point for "I need to actually run something on this conversation" — as opposed to
 * reading it, which must never come through here.
 */
export async function ensureLiveSession(sessionId: string): Promise<AgentSession | null> {
	const existing = sessions.get(sessionId);
	if (existing) {
		touchSession(sessionId);
		return existing;
	}
	const meta = (await deps.store().listSessions()).find((s) => s.id === sessionId);
	return meta ? activateSession(meta.projectId, sessionId) : null;
}
