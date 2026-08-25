/**
 * Choosing, opening and removing conversations.
 *
 * Opening one is the interesting case: the transcript is read without starting an agent, because
 * looking at a conversation should not cost the second and a half that spawning MCP servers and
 * warming an index takes. The agent starts when something is actually asked of it.
 */

import type { SessionMeta } from "@lyra/core";
import type { SessionActivity } from "@lyra/core/activity";
import { howItStopped, prune, rebuildToolRuns, todosFrom, without } from "./derive.ts";
import type { AppState } from "../store.ts";

type Get = () => AppState;
type Set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

/**
 * Whether this conversation runs in one of the app's own directories rather than in a project.
 *
 * 「不在项目中工作」 and a pull request review both need somewhere to run, and both get a directory
 * under the app's home. Neither is a project, and the difference has to be made here because by the
 * time you are looking at a session all you have is a path.
 */
function isProjectLess(cwd: string, scratchRoots: string[]): boolean {
	return scratchRoots
		.filter(Boolean)
		.map((root) => (root.endsWith("/") ? root : `${root}/`))
		.some((root) => cwd.startsWith(root));
}

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
    /*
     * Out of the last conversation's directory, back to the shared one.
     *
     * `scratchCwd` says where the *next* conversation runs, and opening a project-less one points
     * it at that conversation's own directory. For a pull request review that directory holds the
     * review — its PR.md, whatever was checked out to answer the question — and starting a new
     * conversation there hands all of it to a question that has nothing to do with that review.
     * Projects do not have this problem: 新对话 in a project is meant to be in that project.
     */
    if (!get().workspace) {
      const general = await window.lyra.git.generalScratch().catch(() => null);
      if (general) set({ scratchCwd: general });
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
      // Belongs to the turn being left behind; carrying it over would report this conversation's
      // connection as broken on the strength of another one's — or, for `stopped`, offer to
      // resume a blank conversation on the strength of a pause in the last one.
      retrying: null,
      stopped: null,
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
    /*
     * Which mode this conversation is in, decided from its own directory.
     *
     * A conversation carries where it runs, and opening one has to make the app agree with it.
     * Before this, opening a project-less conversation left whichever project was open still
     * showing in the composer — so the chip named a project the conversation had nothing to do
     * with, and 新对话 from there started the next conversation *in* that project.
     *
     * Both halves are set here rather than only the one that changes: leaving `scratchCwd` behind
     * when moving into a project, or leaving `workspace` behind when moving out of one, is the
     * same bug in the other direction.
     */
    const projectLess = isProjectLess(meta.cwd, get().scratchRoots);
    set({
      /*
       * Opening it is reading it, and reading a result clears it.
       *
       * `done` and `failed` mean "finished since you last looked". The list used to hide them
       * for whichever conversation was on screen and put them straight back the moment you
       * moved on — a green dot on something read half an hour ago, for as long as the app
       * stayed open. Hiding is a render-time trick; this is the state actually changing.
       *
       * `running` and `waiting` survive, because they are about the future rather than the
       * past: a conversation still working, or still blocked on approval, is not finished by
       * being looked at.
       */
      activity: readOutcome(get().activity, meta.id),
      sessionCache: prune(cache, meta.id),
      activeSessionId: meta.id,
      meta: cached?.meta ?? meta,
      messages: cached?.messages ?? [],
      toolRuns: cached?.toolRuns ?? {},
      approvals: [],
      running: false,
      todos: [],
      // Belongs to the turn being left behind; see the note in `newSession`.
      retrying: null,
      stopped: null,
      // Only a session with nothing to show is "loading"; a cached one is already on screen
      // and re-reads quietly behind it.
      loadingSession: !cached,
      pendingUserMessage: null,
      view: "chat",
      ...(projectLess ? { workspace: null, scratchCwd: meta.cwd } : { scratchCwd: null }),
    });

    /*
     * `transcript`, not `open`: reading a conversation must not start an agent for it.
     *
     * Starting one loads skills and spawns MCP child processes — over a second, and pure
     * waste when the click was "let me see what this said". The agent comes up on the first
     * message instead. The cwd comes from the meta we already have, so the git lookup need
     * not wait for the log either.
     */
    /*
     * The git lookup is only asked for when there is a project to ask about.
     *
     * A project-less conversation's directory is one of the app's own, and it is a real directory
     * — so `workspace.info` answers about it perfectly happily, with a name taken from the folder:
     * `general`, or `acme-widgets-42`. Handing that back as the workspace is how a conversation
     * that is explicitly in no project ended up displaying one, named after a path nobody chose.
     */
    const [snapshot, workspace] = await Promise.all([
      window.lyra.sessions.transcript(meta.projectId, meta.id),
      projectLess ? Promise.resolve(null) : window.lyra.workspace.info(meta.cwd),
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
      // No event to go on here, so the transcript answers on its own: a reply the log records as
      // `aborted` was stopped by hand, however long ago.
      stopped: snapshot.running ? null : howItStopped(snapshot.messages),
      running: snapshot.running,
      approvals: snapshot.pendingApprovals,
      toolRuns,
      // Null stays null for a project-less conversation: `?? get().workspace` would put back the
      // project that was open before this one was clicked.
      workspace: projectLess ? null : (workspace ?? get().workspace),
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

/**
 * Drop a finished outcome for one conversation, leaving anything still in progress alone.
 *
 * Returns the same object when there is nothing to clear, so opening a conversation that had no
 * mark does not hand React a new map and re-render every row in the list.
 */
function readOutcome(
  activity: Record<string, SessionActivity>,
  id: string,
): Record<string, SessionActivity> {
  const current = activity[id];
  if (current !== "done" && current !== "failed") return activity;
  const next = { ...activity };
  delete next[id];
  return next;
}
