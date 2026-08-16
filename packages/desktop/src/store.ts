import type {
  AgentEvent,
  Message,
  SessionMeta,
  Settings,
  ToolResult,
  UserContent,
} from "@lyra/core";
import { type SessionActivity } from "@lyra/core/activity";
import { applyAgentEvent } from "./store/apply-event.ts";
import { sessionSlice } from "./store/session-slice.ts";
import { turnSlice } from "./store/turn-slice.ts";
import { workspaceSlice } from "./store/workspace-slice.ts";
import type { TodoItem } from "@lyra/core";
import { create } from "zustand";
import type {
  AgentCapabilities,
  SyncStatus,
  WorkspaceInfo,
} from "../electron/ipc-types.ts";
import { usePrChat } from "./prChatStore.ts";
import { useSide } from "./sideStore.ts";

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
  /** Where pull request conversations are stored, so the sidebar can exclude them. */
  prChatRoot: string;

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

/** Set by the first `bootstrap`, never cleared: there is one renderer per window. */
let booted = false;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  view: "chat",
  settingsSection: "models",
  settings: null,
  sessions: [],
  workspace: null,
  prChatRoot: "",
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
    /*
     * Once per process, however many times it is called.
     *
     * The effect that calls this runs twice under StrictMode, and the second run subscribed a
     * second listener to the same event channel — so every message was applied twice and the
     * first one in a conversation appeared twice on screen. Guarding the whole function rather
     * than just the subscription keeps the session list and workspace lookups from being done
     * twice as well.
     */
    if (booted) return;
    booted = true;

    const [settings, sessions] = await Promise.all([
      window.lyra.settings.get(),
      window.lyra.sessions.list(),
    ]);
    const lastProject = settings.projects
      .slice()
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
    const workspace = lastProject
      ? await window.lyra.workspace.info(lastProject.path)
      : null;
    // Where pull request conversations live, so the sidebar can leave them out. One call, at
    // boot: it is derived from the app's home and cannot change while running.
    const prChatRoot = await window.lyra.git.prChatRoot().catch(() => "");
    set({ settings, sessions, workspace, prChatRoot, ready: true });

    window.lyra.agent.onEvent(({ sessionId, event }) => {
      get().applyEvent(sessionId, event);
      // A pull request's conversation is an ordinary session, so it arrives on this channel too.
      // Both stores filter by session id, so exactly one of them ever draws a given event.
      usePrChat.getState().applyEvent(sessionId, event);
    });
    // The side chat is a separate conversation on a separate channel, for the same reason
    // it is a separate store: its replies must never land in the main transcript.
    window.lyra.sideChat.onEvent(({ sessionId, event }) =>
      useSide.getState().applyEvent(sessionId, event),
    );
    void get().refreshSync();
  },

  setView: (view) => set({ view }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),

  async saveSettings(settings) {
    const saved = await window.lyra.settings.save(settings);
    set({ settings: saved });
  },

  ...workspaceSlice(set, get),
  ...sessionSlice(set, get),
  ...turnSlice(set, get),

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
