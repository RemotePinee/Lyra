import type {
  AgentEvent,
  Message,
  SessionMeta,
  Settings,
  ToolResult,
  UserContent,
} from "@deepwise/core";
import { type SessionActivity } from "@deepwise/core/activity";
import { applyAgentEvent, findMessageSlot } from "./store/apply-event.ts";
import type { TodoItem } from "@deepwise/core";
import { create } from "zustand";
import type {
  AgentCapabilities,
  SyncStatus,
  WorkspaceInfo,
} from "../electron/ipc-types.ts";
import { useSide } from "./sideStore.ts";
import { summarizeToolCall } from "./toolSummary.ts";
import { settleTail } from "./transcript.ts";

export type View = "chat" | "settings" | "pull-requests" | "scheduled";

export type SettingsSection =
  | "general"
  | "appearance"
  | "models"
  | "browser"
  | "plugins"
  | "skills"
  | "agents"
  | "mcp"
  | "commands"
  | "hooks"
  | "index"
  | "usage"
  | "sync"
  | "archived";

export interface ToolRun {
  toolCallId: string;
  toolName: string;
  summary: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  result?: ToolResult;
  startedAt: number;
  finishedAt?: number;
}

export interface PendingApproval {
  id: string;
  kind: string;
  title: string;
  detail: string;
}

export interface AppState {
  ready: boolean;
  view: View;
  settingsSection: SettingsSection;

  settings: Settings | null;
  sessions: SessionMeta[];
  workspace: WorkspaceInfo | null;

  activeSessionId: string | null;
  meta: SessionMeta | null;
  messages: Message[];
  /** True between clicking a session and its transcript arriving. Drives the loading state. */
  loadingSession: boolean;
  /**
   * The message the composer painted before the agent confirmed it, held by reference so the
   * stored copy can replace it instead of appearing twice.
   */
  pendingUserMessage: Message | null;
  /**
   * Transcripts already read this run, keyed by session id.
   *
   * Re-opening a session still re-reads its log — that is how a turn driven from the phone
   * shows up — but the cached copy goes on screen straight away, so switching back to
   * somewhere you have already been does not flash a skeleton at you.
   */
  sessionCache: Record<
    string,
    {
      meta: SessionMeta;
      messages: Message[];
      toolRuns: Record<string, ToolRun>;
    }
  >;
  running: boolean;
  /**
   * When the turn in progress began, and what it has spent so far.
   *
   * A long turn is mostly silence — tool calls scrolling past with no sense of how long this
   * has been going or what it is costing. Both are tracked from the agent's own events so the
   * indicator reports the real thing rather than a guess.
   */
  turnStartedAt: number | null;
  turnTokens: number;
  /** Keyed by toolCallId so results can land on the card the model is still streaming. */
  toolRuns: Record<string, ToolRun>;
  approvals: PendingApproval[];
  /** Per-conversation state for the sidebar; absent means idle. */
  activity: Record<string, SessionActivity>;
  /**
   * The connection dropped and this turn is being retried.
   *
   * Belongs to the turn, so it is cleared when one starts or ends rather than dismissed. Before
   * this it went to the corner of the window with the notices, where it outlived the turn it
   * described and sat next to messages that had nothing to do with it.
   */
  retrying: { attempt: number; delayMs: number; reason: string } | null;
  /**
   * The agent's own plan for this piece of work, as it last wrote it.
   *
   * `todo_write` replaces the whole list every call, so the newest result is the whole truth and
   * there is nothing to merge. Kept beside the transcript rather than read out of it: it is the
   * current state of the work, and hunting back through tool cards for the last one is exactly
   * the reading the list exists to save.
   */
  todos: TodoItem[];
  /**
   * The last turn stopped without finishing, and nothing is running now.
   *
   * A reply left `pending` in the log means the process holding it went away mid-turn — the app
   * was quit, it crashed, the machine slept. Reopening such a conversation showed the last
   * half-written message and no explanation, as if the agent had simply gone quiet.
   */
  interrupted: boolean;
  /** Where history was summarised, by position in the transcript. */
  compactions: { at: number; before: number; after: number }[];
  notices: { id: string; level: "info" | "warn" | "error"; message: string }[];
  capabilities: AgentCapabilities | null;
  sync: SyncStatus | null;

  bootstrap(): Promise<void>;
  setView(view: View): void;
  setSettingsSection(section: SettingsSection): void;
  saveSettings(settings: Settings): Promise<void>;

  pickWorkspace(): Promise<void>;
  openWorkspace(path: string): Promise<void>;
  /** Re-read git state for the current project, after a branch switch or an external change. */
  refreshWorkspace(): Promise<void>;
  /** Work without a project. Sessions still run; they just have no repo behind them. */
  clearWorkspace(): void;
  /** Rename a project, or drop it from the list without touching anything on disk. */
  renameProject(path: string, name: string): Promise<void>;
  setProjectPinned(path: string, pinned: boolean): Promise<void>;
  removeProject(path: string): Promise<void>;
  /** Archive every session belonging to one project. */
  archiveProjectSessions(path: string): Promise<void>;
  newSession(): Promise<void>;
  openSession(meta: SessionMeta): Promise<void>;
  deleteSession(meta: SessionMeta): Promise<void>;
  setSessionArchived(meta: SessionMeta, archived: boolean): Promise<void>;
  deleteArchivedSessions(): Promise<void>;

  send(content: UserContent[]): Promise<void>;
  /** Replace a message and re-run from there; everything after it is discarded. */
  editMessage(index: number, content: UserContent[]): Promise<void>;
  /** Re-send the user message that produced the reply at `index`. */
  retryFrom(index: number): Promise<void>;
  abort(): Promise<void>;
  respondToApproval(
    id: string,
    decision: "once" | "always" | "reject",
  ): Promise<void>;
  setModel(modelId: string): Promise<void>;
  refreshSync(): Promise<void>;
  dismissNotice(id: string): void;
  notify(message: string, level?: "info" | "warn" | "error"): void;
  applyEvent(sessionId: string, event: AgentEvent): void;
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  view: "chat",
  settingsSection: "models",
  settings: null,
  sessions: [],
  workspace: null,
  activeSessionId: null,
  meta: null,
  messages: [],
  loadingSession: false,
  pendingUserMessage: null,
  sessionCache: {},
  running: false,
  turnStartedAt: null,
  turnTokens: 0,
  toolRuns: {},
  approvals: [],
  activity: {},
  retrying: null,
  interrupted: false,
  compactions: [],
  todos: [],
  notices: [],
  capabilities: null,
  sync: null,

  async bootstrap() {
    const [settings, sessions] = await Promise.all([
      window.deepwise.settings.get(),
      window.deepwise.sessions.list(),
    ]);
    const lastProject = settings.projects
      .slice()
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
    const workspace = lastProject
      ? await window.deepwise.workspace.info(lastProject.path)
      : null;
    set({ settings, sessions, workspace, ready: true });

    window.deepwise.agent.onEvent(({ sessionId, event }) =>
      get().applyEvent(sessionId, event),
    );
    // The side chat is a separate conversation on a separate channel, for the same reason
    // it is a separate store: its replies must never land in the main transcript.
    window.deepwise.sideChat.onEvent(({ sessionId, event }) =>
      useSide.getState().applyEvent(sessionId, event),
    );
    void get().refreshSync();
  },

  setView: (view) => set({ view }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),

  async saveSettings(settings) {
    const saved = await window.deepwise.settings.save(settings);
    set({ settings: saved });
  },

  async pickWorkspace() {
    const workspace = await window.deepwise.workspace.pick();
    if (!workspace) return;
    await get().openWorkspace(workspace.path);
  },

  async openWorkspace(path) {
    const workspace = await window.deepwise.workspace.info(path);
    if (!workspace) return;
    const settings = get().settings;
    if (settings) {
      const projects = settings.projects.filter((p) => p.path !== path);
      await get().saveSettings({
        ...settings,
        projects: [
          {
            id: path,
            name: workspace.name,
            path,
            pinned:
              settings.projects.find((p) => p.path === path)?.pinned ?? false,
            lastOpenedAt: Date.now(),
          },
          ...projects,
        ],
      });
    }
    set({
      workspace,
      activeSessionId: null,
      meta: null,
      messages: [],
      toolRuns: {},
      approvals: [],
      loadingSession: false,
      pendingUserMessage: null,
    });
  },

  async refreshWorkspace() {
    const current = get().workspace;
    if (!current) return;
    const workspace = await window.deepwise.workspace.info(current.path);
    if (workspace) set({ workspace });
  },

  clearWorkspace() {
    set({
      workspace: null,
      activeSessionId: null,
      meta: null,
      messages: [],
      toolRuns: {},
      approvals: [],
      loadingSession: false,
      pendingUserMessage: null,
    });
  },

  async renameProject(path, name) {
    const settings = get().settings;
    const trimmed = name.trim();
    if (!settings || !trimmed) return;
    await get().saveSettings({
      ...settings,
      projects: settings.projects.map((p) =>
        p.path === path ? { ...p, name: trimmed } : p,
      ),
    });
    // The header reads the workspace, not the project list, so it needs telling separately.
    const workspace = get().workspace;
    if (workspace?.path === path)
      set({ workspace: { ...workspace, name: trimmed } });
  },

  async setProjectPinned(path, pinned) {
    const settings = get().settings;
    if (!settings) return;
    await get().saveSettings({
      ...settings,
      projects: settings.projects.map((p) =>
        p.path === path ? { ...p, pinned } : p,
      ),
    });
  },

  async removeProject(path) {
    const settings = get().settings;
    if (!settings) return;
    // Only the entry goes. The sessions and the directory itself are left alone — this is
    // "stop listing this", not "delete my work".
    await get().saveSettings({
      ...settings,
      projects: settings.projects.filter((p) => p.path !== path),
    });
    if (get().workspace?.path === path) get().clearWorkspace();
  },

  async archiveProjectSessions(path) {
    const targets = get().sessions.filter((s) => s.cwd === path && !s.archived);
    if (targets.length === 0) return;
    set({
      sessions: get().sessions.map((s) =>
        s.cwd === path && !s.archived ? { ...s, archived: true } : s,
      ),
    });
    if (targets.some((s) => s.id === get().activeSessionId)) {
      set({
        activeSessionId: null,
        meta: null,
        messages: [],
        toolRuns: {},
        approvals: [],
        loadingSession: false,
        pendingUserMessage: null,
      });
    }
    // Sequential rather than parallel: each call rewrites the shared session index.
    let latest = get().sessions;
    for (const session of targets) {
      latest = await window.deepwise.sessions.setArchived(
        session.projectId,
        session.id,
        true,
      );
    }
    set({ sessions: latest });
    get().notify(`已归档 ${targets.length} 个聊天`);
  },

  /**
   * Start a blank conversation.
   *
   * Nothing is written yet. A session used to be created on this click, which meant every
   * press of "新对话" left a titleless, messageless row in the sidebar and a file on disk —
   * and pressing it twice produced two. A blank conversation is a UI state, not a stored
   * object; `send` turns it into one the moment there is something to store.
   */
  async newSession() {
    if (!get().workspace) {
      await get().pickWorkspace();
      return;
    }
    set({
      activeSessionId: null,
      meta: null,
      messages: [],
      toolRuns: {},
      approvals: [],
      running: false,
      todos: [],
      turnStartedAt: null,
      loadingSession: false,
      pendingUserMessage: null,
      capabilities: null,
      view: "chat",
    });
  },

  async openSession(meta) {
    /*
     * Select first, load second.
     *
     * Opening a stored session replays its whole log and spins up its MCP servers, which
     * can take a second or more. Waiting for that before touching state meant a click
     * produced no feedback at all — the row you pressed stayed unselected and the old
     * transcript stayed on screen, so it read as a dropped click. The sidebar's own copy
     * of the meta is enough to paint the selection immediately.
     */
    const cache = { ...get().sessionCache };

    // Park the transcript being left behind, so coming back to it needs no round trip.
    const leaving = get().activeSessionId;
    const leavingMeta = get().meta;
    if (
      leaving &&
      leaving !== meta.id &&
      leavingMeta &&
      get().messages.length > 0
    ) {
      cache[leaving] = {
        meta: leavingMeta,
        messages: get().messages,
        toolRuns: get().toolRuns,
      };
    }

    const cached = cache[meta.id];
    set({
      sessionCache: prune(cache, meta.id),
      activeSessionId: meta.id,
      meta: cached?.meta ?? meta,
      messages: cached?.messages ?? [],
      toolRuns: cached?.toolRuns ?? {},
      approvals: [],
      running: false,
      todos: [],
      // Only a session with nothing to show is "loading"; a cached one is already on screen
      // and re-reads quietly behind it.
      loadingSession: !cached,
      pendingUserMessage: null,
      view: "chat",
    });

    /*
     * `transcript`, not `open`: reading a conversation must not start an agent for it.
     *
     * Starting one loads skills and spawns MCP child processes — over a second, and pure
     * waste when the click was "let me see what this said". The agent comes up on the first
     * message instead. The cwd comes from the meta we already have, so the git lookup need
     * not wait for the log either.
     */
    const [snapshot, workspace] = await Promise.all([
      window.deepwise.sessions.transcript(meta.projectId, meta.id),
      window.deepwise.workspace.info(meta.cwd),
    ]);

    // A second click while this was in flight wins; discard the stale arrival.
    if (get().activeSessionId !== meta.id) return;
    if (!snapshot) {
      set({ loadingSession: false });
      return;
    }

    const toolRuns = rebuildToolRuns(snapshot.messages);
    set({
      meta: snapshot.meta,
      messages: snapshot.messages,
      // Replayed from the log rather than the event stream: reopening a conversation does not
      // re-run its tools, so the plan has to be recovered from where the tool wrote it.
      todos: todosFrom(snapshot.messages),
      // Replayed from the log: the summary itself is not in the transcript, only the fact.
      compactions: (snapshot.compactions ?? []).map((at) => ({ at, before: 0, after: 0 })),
      interrupted: !snapshot.running && wasCutShort(snapshot.messages),
      running: snapshot.running,
      approvals: snapshot.pendingApprovals,
      toolRuns,
      workspace: workspace ?? get().workspace,
      loadingSession: false,
      sessionCache: {
        ...get().sessionCache,
        [meta.id]: {
          meta: snapshot.meta,
          messages: snapshot.messages,
          toolRuns,
        },
      },
    });

    // Capabilities describe a running agent; a transcript read from disk has none until the
    // session is activated, which the first message does.
    const capabilities = await window.deepwise.sessions.capabilities(
      snapshot.meta.id,
    );
    if (get().activeSessionId === meta.id) set({ capabilities });
  },

  async deleteSession(meta) {
    set({ sessionCache: without(get().sessionCache, meta.id) });
    await window.deepwise.sessions.remove(meta.projectId, meta.id);
    const sessions = await window.deepwise.sessions.list();
    set({ sessions });
    if (get().activeSessionId === meta.id) {
      set({
        activeSessionId: null,
        meta: null,
        messages: [],
        toolRuns: {},
        approvals: [],
        loadingSession: false,
        pendingUserMessage: null,
      });
    }
  },

  async setSessionArchived(meta, archived) {
    if (archived) set({ sessionCache: without(get().sessionCache, meta.id) });
    // Optimistic: the row should leave the sidebar on the click, not on the round trip.
    set({
      sessions: get().sessions.map((s) =>
        s.id === meta.id ? { ...s, archived } : s,
      ),
    });
    if (archived && get().activeSessionId === meta.id) {
      set({
        activeSessionId: null,
        meta: null,
        messages: [],
        toolRuns: {},
        approvals: [],
        loadingSession: false,
        pendingUserMessage: null,
      });
    }
    set({
      sessions: await window.deepwise.sessions.setArchived(
        meta.projectId,
        meta.id,
        archived,
      ),
    });
  },

  async deleteArchivedSessions() {
    set({ sessions: await window.deepwise.sessions.removeArchived() });
  },

  async send(content) {
    const { workspace, settings } = get();
    let sessionId = get().activeSessionId;
    if (!sessionId && !workspace) {
      await get().pickWorkspace();
      return;
    }

    /*
     * Paint the message before anything is stored.
     *
     * Creating a session takes around two seconds — skills, MCP servers, the symbol index.
     * Until that returned, the composer had cleared and nothing had appeared in its place,
     * which reads as a swallowed message. The agent's own copy replaces this one when
     * `message_start` arrives.
     */
    const pending: Message = { role: "user", content, timestamp: Date.now() };
    set({
      messages: [...get().messages, pending],
      pendingUserMessage: pending,
      running: true,
      turnStartedAt: Date.now(),
      turnTokens: 0,
    });

    // This is where a blank conversation becomes a real one — the first message is the
    // first thing worth storing, so it is also the first thing that creates a session.
    if (!sessionId) {
      try {
        const snapshot = await window.deepwise.sessions.create(
          workspace!.path,
          settings?.defaultModelId ?? "",
        );
        sessionId = snapshot.meta.id;
        set({
          activeSessionId: sessionId,
          meta: snapshot.meta,
          toolRuns: {},
          approvals: [],
          loadingSession: false,
          // Straight into the list rather than waiting on a round trip: `agent:prompt`
          // does not resolve until the turn ends, which would leave the row you are
          // actively talking to missing from the sidebar for the whole reply. The
          // title arrives with the refresh at `agent_end`.
          sessions: [snapshot.meta, ...get().sessions],
        });
        void window.deepwise.sessions
          .capabilities(sessionId)
          .then((capabilities) => {
            if (get().activeSessionId === sessionId) set({ capabilities });
          });
      } catch (cause) {
        set({
          running: false,
          turnStartedAt: null,
          pendingUserMessage: null,
          messages: get().messages.filter((m) => m !== pending),
          notices: [
            ...get().notices,
            {
              id: `${Date.now()}-${Math.random()}`,
              level: "error" as const,
              message: `新建会话失败：${cause instanceof Error ? cause.message : String(cause)}`,
            },
          ],
        });
        return;
      }
    }

    await window.deepwise.agent.prompt(sessionId, content);
  },

  /**
   * Run the turn again, from the message that started it.
   *
   * Failures are usually transport-level — a dropped socket, a relay hiccup — and the right
   * response is to send exactly the same thing again. Implemented on top of `editMessage`
   * because re-asking a question *is* replacing it with itself: everything after has to go,
   * for the same reason it does when the wording changes.
   */
  async retryFrom(index) {
    const messages = get().messages;
    for (let i = Math.min(index, messages.length - 1); i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user" && !message.synthetic) {
        await get().editMessage(i, message.content);
        return;
      }
    }
  },

  async editMessage(index, content) {
    const sessionId = get().activeSessionId;
    if (!sessionId || get().running) return;

    /*
     * Optimistic, and destructive on purpose.
     *
     * The reply being replaced is on screen right now; leaving it there while the new turn
     * spins up would show an answer to a question that has already been withdrawn. Cutting
     * first makes the screen agree with what is about to be sent.
     */
    const pending: Message = { role: "user", content, timestamp: Date.now() };
    set({
      messages: [...get().messages.slice(0, index), pending],
      pendingUserMessage: pending,
      toolRuns: {},
      approvals: [],
      running: true,
      turnStartedAt: Date.now(),
      turnTokens: 0,
      // The cached copy is now wrong; it will be rebuilt from the events that follow.
      sessionCache: without(get().sessionCache, sessionId),
    });

    await window.deepwise.agent.editMessage(sessionId, index, content);
  },

  async abort() {
    const sessionId = get().activeSessionId;
    if (sessionId) await window.deepwise.agent.abort(sessionId);
  },

  async respondToApproval(id, decision) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    set({ approvals: get().approvals.filter((a) => a.id !== id) });
    await window.deepwise.agent.approve(sessionId, id, decision);
  },

  /**
   * Choose the model for the conversation about to start.
   *
   * Refused once one has started, and not as a matter of taste. Stored messages carry
   * provider-specific handles — the Responses `responseId` that chains a conversation, the
   * `signature` on a thinking or tool-call block, the encrypted reasoning payload replayed on
   * the next turn. None of it survives a change of model: at best the reasoning context is
   * silently dropped, at worst the next request is rejected outright. Across API formats the
   * whole history would have to be re-translated, and thinking blocks cannot be.
   *
   * So the model is settled by the first message. Wanting a different one means wanting a
   * different conversation.
   */
  async setModel(modelId) {
    const { activeSessionId, settings, meta } = get();
    if (get().messages.length > 0) {
      get().notify(
        "对话开始后不能更换模型，历史里的推理上下文无法跨模型使用。新建对话即可换。",
        "warn",
      );
      return;
    }
    if (activeSessionId)
      await window.deepwise.agent.setModel(activeSessionId, modelId);
    if (meta) set({ meta: { ...meta, modelId } });
    if (settings)
      await get().saveSettings({ ...settings, defaultModelId: modelId });
  },

  async refreshSync() {
    set({ sync: await window.deepwise.sync.status() });
  },

  dismissNotice: (id) =>
    set({ notices: get().notices.filter((n) => n.id !== id) }),

  notify: (message, level = "info") =>
    set({
      notices: [
        ...get().notices,
        { id: `${Date.now()}-${Math.random()}`, level, message },
      ],
    }),

  applyEvent(sessionId, event) {
    applyAgentEvent(sessionId, event, set, get);
  },
}));

type Cache = Record<
  string,
  { meta: SessionMeta; messages: Message[]; toolRuns: Record<string, ToolRun> }
>;

/** How many transcripts to hold. Enough to cover switching around a project, not a whole day. */
const CACHE_LIMIT = 12;

/** Drop the least recently used entries, never the one being opened. */
function prune(cache: Cache, keep: string): Cache {
  const ids = Object.keys(cache);
  if (ids.length <= CACHE_LIMIT) return cache;
  const next = { ...cache };
  // Insertion order is recency order here: entries are re-added as sessions are visited.
  for (const id of ids.slice(0, ids.length - CACHE_LIMIT))
    if (id !== keep) delete next[id];
  return next;
}

function without(cache: Cache, id: string): Cache {
  if (!(id in cache)) return cache;
  const next = { ...cache };
  delete next[id];
  return next;
}


/** Reconstruct tool cards when opening a stored session. */
export /**
 * Whether the conversation was left mid-turn.
 *
 * Two shapes mean the same thing. A reply still marked `pending` never reached its end; a
 * finished reply whose tool calls have no results was cut off between asking for the tools and
 * running them. Either way the work stopped somewhere it did not choose to.
 */
function wasCutShort(messages: Message[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "pending") return true;
		const calls = message.content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) return false;
		const answered = new Set(
			messages.slice(i + 1).flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
		);
		return calls.some((call) => call.type === "toolCall" && !answered.has(call.id));
	}
	return false;
}

/**
 * The last task list written in a conversation.
 *
 * Searched backwards because `todo_write` sends the whole list every time — the newest one is
 * the only one that matters, and the ones before it are its earlier drafts.
 */
function todosFrom(messages: Message[]): TodoItem[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;
		const details = message.details as { kind?: string; todos?: TodoItem[] } | undefined;
		if (details?.kind === "todo" && Array.isArray(details.todos)) return details.todos;
	}
	return [];
}

/** Reconstruct tool cards when opening a stored session. */
export function rebuildToolRuns(messages: Message[]): Record<string, ToolRun> {
  const runs: Record<string, ToolRun> = {};
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        runs[block.id] = {
          toolCallId: block.id,
          toolName: block.name,
          summary: summarizeToolCall(block.name, block.arguments),
          args: block.arguments,
          status: "running",
          startedAt: message.timestamp,
        };
      }
    } else if (message.role === "toolResult") {
      const run = runs[message.toolCallId];
      if (run) {
        run.status = message.isError ? "error" : "done";
        run.result = {
          content: message.content,
          details: message.details,
          isError: message.isError,
        };
        run.finishedAt = message.timestamp;
      }
    }
  }

  /*
   * A call with no result did not survive; it is not still running.
   *
   * Tool state is rebuilt from the log, and a call is only marked finished when its result is
   * written. Quit the app — or lose the renderer — while a command is running and no result is
   * ever recorded, so re-opening that session showed a spinner counting up from a process that
   * stopped existing minutes ago. Nine minutes on a `git status` is not a slow command, it is a
   * lie about what is happening.
   *
   * Only when the turn itself has settled: a session that is genuinely mid-turn in the
   * background has calls that legitimately have no result yet.
   */
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const turnInFlight = lastAssistant?.role === "assistant" && lastAssistant.stopReason === "pending";
  if (!turnInFlight) {
    for (const run of Object.values(runs)) {
      if (run.status !== "running") continue;
      run.status = "error";
      run.result = { content: [{ type: "text", text: "这次调用没有结果：应用在它结束之前退出了。" }], isError: true };
      run.finishedAt = run.startedAt;
    }
  }

  return runs;
}
