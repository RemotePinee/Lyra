/**
 * Choosing, opening and removing conversations.
 *
 * Opening one is the interesting case: the transcript is read without starting an agent, because
 * looking at a conversation should not cost the second and a half that spawning MCP servers and
 * warming an index takes. The agent starts when something is actually asked of it.
 */

import type { SessionMeta } from "@lyra/core";
import { prune, rebuildToolRuns, todosFrom, wasCutShort, without } from "./derive.ts";
import type { AppState } from "../store.ts";

type Get = () => AppState;
type Set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

export function sessionSlice(set: Set, get: Get) {
  return {
  /**
   * Start a blank conversation.
   *
   * Nothing is written yet. A session used to be created on this click, which meant every
   * press of "新对话" left a titleless, messageless row in the sidebar and a file on disk —
   * and pressing it twice produced two. A blank conversation is a UI state, not a stored
   * object; `send` turns it into one the moment there is something to store.
   */
  async newSession() {
    // A scratch directory counts: a conversation with no project is still a conversation.
    if (!get().workspace && !get().scratchCwd) {
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

  async openSession(meta: SessionMeta) {
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
      window.lyra.sessions.transcript(meta.projectId, meta.id),
      window.lyra.workspace.info(meta.cwd),
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
    const capabilities = await window.lyra.sessions.capabilities(
      snapshot.meta.id,
    );
    if (get().activeSessionId === meta.id) set({ capabilities });
  },

  async deleteSession(meta: SessionMeta) {
    set({ sessionCache: without(get().sessionCache, meta.id) });
    await window.lyra.sessions.remove(meta.projectId, meta.id);
    const sessions = await window.lyra.sessions.list();
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

  async setSessionArchived(meta: SessionMeta, archived: boolean) {
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
      sessions: await window.lyra.sessions.setArchived(
        meta.projectId,
        meta.id,
        archived,
      ),
    });
  },

  async deleteArchivedSessions() {
    set({ sessions: await window.lyra.sessions.removeArchived() });
  },
  };
}

