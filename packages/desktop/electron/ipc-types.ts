/**
 * Everything the renderer may ask the main process to do.
 *
 * One interface, grouped by subject, and the only description of the boundary there is — the
 * preload builds `window.lyra` against it and the handlers are registered against the same
 * channel names, so a call that is not written here does not exist.
 *
 * The values it passes are in `ipc-shapes`, re-exported below so a caller still imports one thing.
 */

import type { TrajectoryEntry } from "@lyra/core";
import type { BranchList, GitCommit, GitStatus, RepoRef } from "./git.ts";

import type {
	AgentEvent,
	ApprovalDecision,
	BundleKind,
	ContextBreakdown,
	McpBundle,
	Registry,
	RegistryEntry,
	Plugin,
	QueuedTask,
	SessionMeta,
	Settings,
	Skill,
	UserContent,
} from "@lyra/core";

import type {
	AgentCapabilities,
	PullRequestDetail,
	FileContents,
	FileEntry,
	ProviderTestResult,
	PullRequestSummary,
	RefDiff,
	SessionSnapshot,
	SideChatSnapshot,
	SyncStatus,
	WorkspaceDiffFile,
	WorkspaceInfo,
} from "./ipc-shapes.ts";

export * from "./ipc-shapes.ts";

export interface LyraApi {
	settings: {
		get(): Promise<Settings>;
		save(settings: Settings): Promise<Settings>;
		/**
		 * Settings changed on the other side of the boundary.
		 *
		 * The renderer is not the only thing that writes them: installing an MCP bundle adds its
		 * servers, uninstalling takes them away, sync rotates its token, an approval appends to
		 * `alwaysAllow`. The main process has always broadcast this and nothing has ever listened,
		 * so the window went on showing the settings it last saved itself — install a server from
		 * the catalogue and the MCP page did not have it until the app was restarted.
		 */
		onChanged(handler: (settings: Settings) => void): () => void;
	};
	workspace: {
		/** Show the project directory in the OS file manager. */
		reveal(path: string): Promise<void>;
		pick(): Promise<WorkspaceInfo | null>;
		info(path: string): Promise<WorkspaceInfo | null>;
	};
	sessions: {
		list(): Promise<SessionMeta[]>;
		create(cwd: string, modelId: string): Promise<SessionSnapshot>;
		/** Start the agent for this session — skills, MCP servers, the lot. For running things. */
		open(projectId: string, sessionId: string): Promise<SessionSnapshot | null>;
		/** Read the stored transcript without starting anything. For looking at things. */
		transcript(projectId: string, sessionId: string): Promise<SessionSnapshot | null>;
		/** The same log, read as a trajectory: one entry per thing that happened, by source. */
		trajectory(projectId: string, sessionId: string): Promise<TrajectoryEntry[]>;
		/** Copy history up to `seq` into a new session, leaving this one untouched. */
		fork(projectId: string, sessionId: string, seq: number): Promise<{ meta: SessionMeta; messages: number } | null>;
		remove(projectId: string, sessionId: string): Promise<void>;
		/** Move a session in or out of the archive. Returns the whole list, already updated. */
		setArchived(projectId: string, sessionId: string, archived: boolean): Promise<SessionMeta[]>;
		/** Delete every archived session at once. Returns the remaining list. */
		removeArchived(): Promise<SessionMeta[]>;
		capabilities(sessionId: string): Promise<AgentCapabilities | null>;
		/** Null when the session is not open — this never boots one just to answer. */
		contextBreakdown(sessionId: string): Promise<ContextBreakdown | null>;
	};
	agent: {
		prompt(sessionId: string, content: UserContent[]): Promise<void>;
		/** Replace a message and re-run from there, discarding everything after it. */
		editMessage(sessionId: string, messageIndex: number, content: UserContent[]): Promise<void>;
		abort(sessionId: string): Promise<void>;
		approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
		setModel(sessionId: string, modelId: string): Promise<void>;
		onEvent(handler: (payload: { sessionId: string; event: AgentEvent }) => void): () => void;
	};
	/**
	 * The second conversation attached to a session: reads its transcript, writes nothing back.
	 *
	 * Its events ride a separate channel from `agent.onEvent` for the obvious reason — they
	 * describe a different conversation, and mixing them would paint side-chat replies into
	 * the main transcript.
	 */
	sideChat: {
		/** Null when this session has never had one opened. */
		state(sessionId: string): Promise<SideChatSnapshot | null>;
		ask(sessionId: string, content: UserContent[]): Promise<void>;
		abort(sessionId: string): Promise<void>;
		/** Throw the conversation away and start fresh. The main session is untouched. */
		reset(sessionId: string): Promise<void>;
		onEvent(handler: (payload: { sessionId: string; event: AgentEvent }) => void): () => void;
	};
	/** Work the side chat handed to a session, waiting for it to be free. */
	tasks: {
		list(sessionId: string): Promise<QueuedTask[]>;
		/** Only a task that has not started can be withdrawn; stopping a running one is `abort`. */
		cancel(sessionId: string, taskId: string): Promise<boolean>;
	};
	/**
	 * Reading the project's files, for the panel's file browser.
	 *
	 * Confined to the open project: both calls refuse a path outside it. The browser is for
	 * looking at what you are working on, and a file picker that can wander into the rest of
	 * the disk is a different, riskier thing than what was asked for.
	 */
	files: {
		list(dir: string): Promise<FileEntry[]>;
		read(path: string): Promise<FileContents | null>;
		/** Overwrite a file. Refused outside the open project, same as reading. */
		write(path: string, text: string): Promise<{ ok: boolean; error?: string }>;
		/**
		 * A URL the renderer can put in `src` for images, video and audio.
		 *
		 * Served over a private scheme whose handler re-checks the project boundary, so media
		 * streams (with range requests, so a video can seek) instead of being base64'd through
		 * IPC — a 40MB clip would otherwise have to become a 55MB string first.
		 */
		mediaUrl(path: string): string;
	};
	/** A real pseudo-terminal, one per tab. */
	terminal: {
		create(cwd: string, cols: number, rows: number): Promise<string>;
		write(id: string, data: string): void;
		resize(id: string, cols: number, rows: number): void;
		kill(id: string): void;
		onData(handler: (payload: { id: string; data: string }) => void): () => void;
		onExit(handler: (payload: { id: string; code: number }) => void): () => void;
	};
	providers: {
		test(providerId: string): Promise<ProviderTestResult>;
	};
	sync: {
		status(): Promise<SyncStatus>;
		start(): Promise<SyncStatus>;
		stop(): Promise<SyncStatus>;
		rotateToken(): Promise<SyncStatus>;
	};
	plugins: {
		/** Scan plugin and skill directories without needing an open session. */
		list(cwd: string): Promise<{
			plugins: Plugin[];
			/** Directories that turned out to be MCP servers rather than plugins. */
			mcpBundles: McpBundle[];
			pluginDiagnostics: { path: string; message: string }[];
			skills: Skill[];
			skillDiagnostics: { path: string; message: string }[];
		}>;
		/** Absolute path to the plugins directory, created if missing. */
		revealDir(scope: "workspace" | "user", cwd: string): Promise<string>;
		/** Write a runnable example bundle so the format is discoverable. */
		/** Read a registry index. Failures come back as data — a bad URL is routine, not exceptional. */
		fetchRegistry(url: string): Promise<{ ok: true; registry: Registry } | { ok: false; message: string }>;
		/** A registry logo as a data URL, or null. Fetched in the main process; see `registry:icon`. */
		icon(url: string): Promise<string | null>;
		/**
		 * Clone an entry and file it by what it turns out to be.
		 *
		 * `kind` comes back because the index's claim is only a claim: install something listed as
		 * a plugin that holds nothing but a `.mcp.json` and what you have installed is an MCP
		 * server, whose servers are now in settings switched off, waiting to be turned on.
		 */
		installFromRegistry(
			entry: RegistryEntry,
			registryName?: string,
		): Promise<{ ok: true; dir: string; kind: BundleKind; servers: number } | { ok: false; message: string }>;
		uninstall(id: string): Promise<void>;
	};
	/**
	 * Tell the window itself what the theme is.
	 *
	 * Two things depend on it: the OS-drawn controls on Windows and Linux, and — on every
	 * platform — the window's own backing colour, which is what a fast resize exposes before
	 * the renderer catches up.
	 */
	setWindowTheme(colors: { color: string; symbolColor: string }): void;
	/** macOS only; a no-op elsewhere. Translucency is a window material, not a CSS colour. */
	setVibrancy(on: boolean): void;
	/**
	 * Native full screen, reported by the window because the page cannot detect it.
	 *
	 * macOS hides the traffic lights in full screen, and everything inset to clear them has to
	 * stop reserving that space. Fires on entry, on exit, and once after load.
	 */
	onFullScreenChange(handler: (fullScreen: boolean) => void): () => void;
	/**
	 * A menu item on the status bar icon was chosen.
	 *
	 * Sent only once the window can receive it, so a command given while the app was closed still
	 * lands — the renderer never has to care whether it was already running.
	 */
	onTrayCommand(handler: (command: string) => void): () => void;
	updates: {
		/** Whether a newer release exists. Never throws: offline is a normal answer, not an error. */
		check(force?: boolean): Promise<{
			current: string;
			latest: string;
			available: boolean;
			notes: string;
			url: string;
			publishedAt: number | null;
			asset: { name: string; url: string; size: number } | null;
		}>;
		/** Fetches this platform's installer and opens it. Progress arrives on `onProgress`. */
		download(version: string): Promise<{ ok: boolean; error?: string }>;
		/** Opens the release page in the browser. Refuses anything that is not a github.com URL. */
		open(url: string): Promise<boolean>;
		onProgress(listener: (payload: { received: number; total: number; done?: boolean }) => void): () => void;
	};
	system: {
		openPath(path: string): Promise<void>;
		openExternal(url: string): Promise<void>;
		openIn(app: string, path: string): Promise<void>;
		revealSkillsDir(scope: "workspace" | "user", cwd: string): Promise<string>;
		platform(): Promise<string>;
		/** The installed app's own icon as a data URL, or null if it is not installed. */
		appIcon(appName: string): Promise<string | null>;
	};
	index: {
		stats(cwd: string): Promise<{ exists: boolean; builtAt?: number; files?: number; symbols?: number; bytes?: number }>;
		rebuild(cwd: string): Promise<{ exists: boolean; builtAt?: number; files?: number; symbols?: number; bytes?: number }>;
		search(cwd: string, query: string): Promise<{ name: string; kind: string; file: string; line: number }[]>;
	};
	scheduler: {
		/** Run a scheduled task immediately, through the same path the timer uses. */
		runNow(taskId: string): Promise<{ ok: boolean; error?: string }>;
	};
	git: {
		/**
		 * Every pull request that concerns you, across every repository.
		 *
		 * Not scoped to the open folder: what is waiting on you on a Monday morning is spread
		 * across everything you work in.
		 */
		myPullRequests(): Promise<{ pullRequests: PullRequestSummary[]; error?: string }>;
		pullRequest(repo: string, number: number): Promise<{ detail?: PullRequestDetail; error?: string }>;
		pullRequestDiff(repo: string, number: number): Promise<{ files: WorkspaceDiffFile[]; error?: string }>;
		/**
		 * A scratch directory for talking about this pull request, with `PR.md` written into it.
		 *
		 * Only used when the repository is not one of the user's projects. Stable across launches
		 * — sessions are keyed by their directory — so reopening the same review months later
		 * finds the same conversation.
		 */
		scratchForPullRequest(pr: {
			repo: string;
			number: number;
			title: string;
			author: string;
			url: string;
			headRefName: string;
			baseRefName: string;
			state: string;
			body: string;
		}): Promise<string>;
		/** The shared scratch directory for 「不在项目中工作」. */
		generalScratch(): Promise<string>;
		/**
		 * Every directory those conversations live under, so the sidebar can tell them from real
		 * projects. More than one because the directory has been renamed and stored sessions still
		 * record the old path.
		 */
		scratchRoots(): Promise<string[]>;
		/**
		 * Which of `candidates` has this repository as its `origin`, or null.
		 *
		 * Candidates are the user's own project paths. Matching is on the remote rather than the
		 * directory name, and a fork does not count: `origin` is what a working copy pushes to.
		 */
		findLocalCheckout(repo: string, candidates: string[]): Promise<string | null>;
		/**
		 * A GitHub account's avatar as a data URL, or null.
		 *
		 * Fetched in the main process on purpose: the renderer's CSP allows no remote images, and
		 * widening it for a decoration would widen it for rendered comment bodies as well.
		 */
		avatar(login: string): Promise<string | null>;
		commentOnPullRequest(repo: string, number: number, body: string): Promise<{ error?: string }>;
		reviewPullRequest(
			repo: string,
			number: number,
			verdict: "approve" | "request-changes" | "comment",
			body: string,
		): Promise<{ error?: string }>;
		/** Local and remote branches, for the composer's branch switcher. */
		branches(cwd: string): Promise<BranchList>;
		switchBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }>;
		createWorktree(cwd: string, branch: string): Promise<{ ok: boolean; path?: string; error?: string }>;
		/**
		 * How much is uncommitted, as three numbers.
		 *
		 * Deliberately separate from `diff.workspaceDiff`: this one is on screen the whole
		 * session and re-runs after every turn, so it counts without building any diffs.
		 */
		stat(cwd: string): Promise<{ branch: string | null; added: number; removed: number; files: number }>;
		/** Stage everything and commit it — the change the bar is counting. */
		commit(cwd: string, message: string): Promise<{ ok: boolean; error?: string }>;

		/* The Git panel's surface. Reading first, then the operations that write. */

		/** Every repository under the workspace — people keep more than one side by side. */
		repos(root: string): Promise<RepoRef[]>;
		/** Linked checkouts of one repository, each on its own branch. */
		worktrees(cwd: string): Promise<RepoRef[]>;
		init(cwd: string): Promise<{ ok: boolean; error?: string }>;
		/** Working tree split by index, with upstream distance. */
		status(cwd: string): Promise<GitStatus>;
		log(cwd: string, limit?: number, ref?: string): Promise<GitCommit[]>;
		/** What one commit changed, against its parent. */
		commitDiff(cwd: string, sha: string): Promise<RefDiff>;
		/** Any two points in history; `head` of null diffs the index against `base`. */
		diffRefs(cwd: string, base: string, head: string | null): Promise<RefDiff>;

		stage(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
		unstage(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
		/** Irreversible: untracked paths are deleted, not restored. */
		discard(cwd: string, paths: string[]): Promise<{ ok: boolean; error?: string }>;
		/** Commits exactly what the panel shows as staged. */
		commitStaged(cwd: string, message: string): Promise<{ ok: boolean; error?: string }>;
		createBranch(cwd: string, name: string, from?: string): Promise<{ ok: boolean; error?: string }>;
		deleteBranch(cwd: string, name: string, force?: boolean): Promise<{ ok: boolean; error?: string }>;
		push(cwd: string): Promise<{ ok: boolean; error?: string }>;
		pull(cwd: string): Promise<{ ok: boolean; error?: string }>;
	};
	diff: {
		/** Uncommitted changes for the review panel. */
		workspaceDiff(cwd: string): Promise<{ files: WorkspaceDiffFile[]; added: number; removed: number; branch: string | null }>;
	};
}

declare global {
	interface Window {
		lyra: LyraApi;
	}
}
