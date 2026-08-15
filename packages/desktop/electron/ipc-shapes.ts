/**
 * The values that cross the process boundary, as shapes.
 *
 * Separate from the API surface that carries them: a snapshot of a session means the same thing
 * whether it arrived by invoke, by event or out of a file, and half of these are re-exports of
 * core's own types — the boundary does not get to have its own idea of what a session is.
 */

import type { TrajectoryEntry } from "@deepwise/core";
import type { BranchList, GitCommit, GitStatus, RepoRef } from "./git.ts";

export type { GitCommit, GitStatus, GitStatusFile, RepoRef } from "./git.ts";

/** The shape every diff view consumes, whatever produced it. */
export interface RefDiff {
	files: WorkspaceDiffFile[];
	added: number;
	removed: number;
}

export type { BranchList };
import type {
	AgentEvent,
	ApprovalDecision,
	ContextBreakdown,
	Registry,
	RegistryEntry,
	ContextSegmentKey,
	McpServerStatus,
	Plugin,
	QueuedTask,
	SessionMeta,
	Settings,
	Skill,
	UserContent,
} from "@deepwise/core";

export type { ContextBreakdown, ContextSegmentKey, QueuedTask, Registry, RegistryEntry };

export interface WorkspaceInfo {
	path: string;
	name: string;
	isGitRepo: boolean;
	branch: string | null;
	/** Uncommitted line counts, shown in the review panel header. */
	added: number;
	removed: number;
}

export interface SessionSnapshot {
	meta: SessionMeta;
	messages: import("@deepwise/core").Message[];
	running: boolean;
	pendingApprovals: { id: string; kind: string; title: string; detail: string }[];
	/** Message positions where history was summarised, so the mark survives a reload. */
	compactions?: number[];
}

/**
 * The side chat's own transcript. Memory-only by design — it is gone when the app restarts,
 * and never reaches the session log.
 */
export interface SideChatSnapshot {
	messages: import("@deepwise/core").Message[];
	running: boolean;
}

export interface FileEntry {
	name: string;
	/** Absolute, so the renderer never has to join paths itself. */
	path: string;
	isDirectory: boolean;
	size: number;
}

export interface FileContents {
	text: string;
	/** True when the file was longer than the read cap and only its head is here. */
	truncated: boolean;
	bytes: number;
	/** Set instead of `text` when the bytes are not text at all. */
	binary?: boolean;
	/** Last-modified time, so an editor can notice the file changed underneath it. */
	modifiedAt: number;
}

export interface AgentCapabilities {
	skills: Skill[];
	skillDiagnostics: { path: string; message: string }[];
	plugins: Plugin[];
	pluginDiagnostics: { path: string; message: string }[];
	mcp: McpServerStatus[];
	agents: { name: string; description: string; source: string; tools: string[] | "*" }[];
	toolNames: string[];
}

export interface ProviderTestResult {
	ok: boolean;
	latencyMs: number;
	message: string;
	/** Model ids the endpoint reported, when it exposes a listing. */
	models?: string[];
}

export interface SyncStatus {
	running: boolean;
	port: number;
	token: string | null;
	addresses: string[];
	clients: number;
	/** Ready-to-scan pairing payload for the mobile app. */
	pairingUrl: string | null;
}

export interface PullRequestSummary {
	number: number;
	title: string;
	author: string;
	state: string;
	isDraft: boolean;
	url: string;
	updatedAt: string;
	additions: number;
	deletions: number;
	headRefName: string;
}

export interface WorkspaceDiffFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	added: number;
	removed: number;
	hunks: import("@deepwise/core").DiffHunk[];
}
