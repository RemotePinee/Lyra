/**
 * The sync server, started on demand and owned here.
 *
 * A phone talks to this rather than to the model: it replays the session log by sequence number and
 * sends prompts back. The server is built lazily because most sessions never turn it on, and
 * exposing a port is not something to do just in case.
 */

import { AgentSession, type SessionStorage } from "@lyra/core";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveInside } from "./file-ops.ts";
import { workspaceInfo } from "./workspace-info.ts";
import { applySettings, onSettingsChanged, settings } from "./app-settings.ts";
import type { SyncStatus } from "./ipc-types.ts";
import { activateSession, broadcast, getOrCreateSession, sessions, snapshot, touchSession } from "./session-hub.ts";
import { SyncServer } from "./sync-server.ts";
import { scanUsage } from "./usage-scan.ts";
import { discardPaths, gitStatus, stagePaths, unstagePaths } from "./git-status.ts";
import { commitStaged, gitLog, pullBranch, pushBranch } from "./git-history.ts";
import { git, listBranches, switchBranch } from "./git.ts";

let syncServer: SyncServer | null = null;
/** Whether the settings listener is already attached; see `startSync`. */
let watchingSettings = false;

/** The running server, or null. Read by the handlers that report status. */
export function syncStatusSource(): SyncServer | null {
	return syncServer;
}

export async function stopSync(): Promise<void> {
	await syncServer?.stop();
}

export function configureSync(read: () => SessionStorage): void {
	readStore = read;
}

let readStore: () => SessionStorage = () => {
	throw new Error("sync used before configure()");
};

export async function startSync(): Promise<SyncStatus> {
	if (!syncServer) {
		syncServer = new SyncServer({
			getSettings: settings,
			saveSettings: async (next) => void (await applySettings(next)),
			store: readStore(),
			workspaceInfo: (path) => workspaceInfo(path),
			live: (id) => sessions.get(id),
			activate: (projectId, id) => activateSession(projectId, id),
			getOrCreate: (cwd, modelId) => getOrCreateSession(cwd, modelId),
			snapshot: (session) => snapshot(session),
			touch: (id) => touchSession(id),
			scanUsage: () => scanUsage(),
			gitStatus: (cwd) => gitStatus(cwd),
			gitStage: (cwd, paths) => stagePaths(cwd, paths),
			gitUnstage: (cwd, paths) => unstagePaths(cwd, paths),
			gitCommit: (cwd, message) => commitStaged(cwd, message),
			gitPush: (cwd) => pushBranch(cwd),
			gitPull: (cwd) => pullBranch(cwd),
			gitDiscard: (cwd, paths) => discardPaths(cwd, paths),
			gitDiff: async (cwd, path, staged) => {
				try {
					const args = ["diff", "--no-color"];
					if (staged) args.push("--staged");
					args.push("--", path);
					return await git(cwd, args);
				} catch {
					return null;
				}
			},
			gitLog: (cwd, limit) => gitLog(cwd, limit),
			gitBranches: (cwd) => listBranches(cwd),
			gitSwitch: (cwd, branch) => switchBranch(cwd, branch),
			listFiles: async (raw: string) => {
				const projectRoots = (settings()?.projects ?? []).map((p) => p.path);
				const dir = resolveInside(raw, projectRoots);
				if (!dir) return [];
				const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
				const out = await Promise.all(
					entries.map(async (entry) => {
						const path = join(dir, entry.name);
						const info = entry.isDirectory() ? null : await stat(path).catch(() => null);
						return { name: entry.name, path, isDirectory: entry.isDirectory(), size: info?.size ?? 0 };
					}),
				);
				return out.sort((a, b) =>
					a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isDirectory ? -1 : 1,
				);
			},
			readFile: async (raw: string) => {
				const projectRoots = (settings()?.projects ?? []).map((p) => p.path);
				const path = resolveInside(raw, projectRoots);
				if (!path) return null;
				const info = await stat(path).catch(() => null);
				if (!info?.isFile()) return null;
				const buffer = await readFile(path).catch(() => null);
				if (!buffer) return null;
				const head = buffer.subarray(0, 8000);
				if (head.includes(0)) return { text: "", truncated: false, bytes: info.size, binary: true, modifiedAt: info.mtimeMs };
				const cap = 512 * 1024;
				const clipped = buffer.subarray(0, cap);
				return {
					text: clipped.toString("utf8"),
					truncated: buffer.byteLength > cap,
					bytes: info.size,
					modifiedAt: info.mtimeMs,
				};
			},
			resolveSession: async (projectId, sessionId) => {
				const existing = sessions.get(sessionId);
				if (existing) return existing;
				const loaded = await readStore().load(projectId, sessionId);
				if (!loaded) return null;
				const session = new AgentSession({
					cwd: loaded.meta.cwd,
					settings: settings(),
					store: readStore(),
					meta: loaded.meta,
					emit: (event) => broadcast(sessionId, event),
				});
				session.restore(loaded.messages, loaded.compaction);
				await session.initialize();
				sessions.set(sessionId, session);
				return session;
			},
			createSession: (cwd, modelId) => getOrCreateSession(cwd, modelId),
		});
	}
	/*
	 * Forward every settings change to whatever phones are connected.
	 *
	 * Registered once, on the first start, and left in place: the listener is cheap, it does nothing
	 * while no server is running, and unsubscribing on stop would mean a phone that reconnects to a
	 * restarted server silently stops hearing about changes.
	 */
	if (!watchingSettings) {
		watchingSettings = true;
		onSettingsChanged((next) => syncServer?.broadcastSettings(next));
	}

	return syncServer.start(settings().sync.port, settings().sync.token);
}
