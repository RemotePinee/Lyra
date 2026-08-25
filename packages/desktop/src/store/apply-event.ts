/**
 * Folding an agent event into the store.
 *
 * The largest thing the store does, and the one most worth reading on its own: every event the
 * runtime emits arrives here, for every conversation at once — including the ones nobody is
 * looking at. Which is why it starts by updating per-session activity and only then asks whether
 * the event belongs to the conversation on screen.
 */

import type { AgentEvent, Message } from "@lyra/core";
import { nextActivity } from "@lyra/core/activity";
import { coalesce, flushCoalesced } from "./coalesce.ts";
import { applyToolEvent } from "./apply-tool.ts";
import { howItStopped } from "./derive.ts";
import { useSide } from "../sideStore.ts";
import type { AppState } from "../store.ts";
import { settleTail } from "../transcript.ts";

type Get = () => AppState;
type Set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

/** Events that can only arrive over a connection that is working again. */
const RECONNECTED = new Set<AgentEvent["type"]>([
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
]);

export function applyAgentEvent(sessionId: string, event: AgentEvent, set: Set, get: Get): void {
  /*
   * Every conversation's state, not just the one on screen.
   *
   * Turns run in conversations you are not looking at — a scheduled task, the phone, an agent
   * that stopped to ask permission twenty minutes ago. The events for those already arrive
   * here and were being dropped; folding each one into a per-session activity is what lets
   * the list say which is which.
   */
  {
    const current = get().activity[sessionId] ?? null;
    const settled = nextActivity(event, current);
    /*
     * A conversation you are watching cannot finish unread.
     *
     * `visibleActivity` hides `done` for the conversation on screen, which looked like enough —
     * but hiding is not clearing. The mark stayed in the map, and the instant you clicked away it
     * became a conversation you had never looked at, complete with the dot. Sitting through a
     * turn and then being told you missed it is the opposite of what the mark is for.
     *
     * Only the finished states. `running` and `waiting` are about what is still to come and are
     * worth carrying out of the conversation with you.
     */
    const finished = settled === "done" || settled === "failed";
    const next = finished && sessionId === get().activeSessionId ? null : settled;

    if (next !== current) {
      const activity = { ...get().activity };
      if (next) activity[sessionId] = next;
      else delete activity[sessionId];
      set({ activity });
    }
  }

  if (sessionId !== get().activeSessionId) {
    if (event.type === "title") {
      set({
        sessions: get().sessions.map((s) =>
          s.id === sessionId ? { ...s, title: event.title } : s,
        ),
      });
      return;
    }
    // A turn driven from the phone still has to move the session up the sidebar and
    // update its title, even though its transcript is not on screen.
    if (event.type === "agent_end" || event.type === "turn_end") {
      void window.lyra.sessions
        .list()
        .then((sessions) => set({ sessions }));
    }
    return;
  }

  /*
   * The reconnection worked, and nothing else was ever going to say so.
   *
   * `retrying` was cleared only when a turn started or ended, so one dropped socket pinned
   * "连接中断，N 秒后重试" to the running line for the rest of the turn — still sitting there a
   * minute later beside a reply that had long since arrived, claiming a wait that was over.
   * Anything streaming in is the proof: the connection is back, so the notice goes.
   */
  if (get().retrying && RECONNECTED.has(event.type)) set({ retrying: null });

  /*
   * Anything that is not a streamed update lands after the one still waiting.
   *
   * Without this a held update could be applied on the next frame — after the `message_end` that
   * settles it, or after the tool card that follows it — and overwrite the newer state with the
   * older one.
   */
  if (event.type !== "message_update") flushCoalesced();

  switch (event.type) {
    case "agent_start":
      set({
        running: true,
        retrying: null,
        stopped: null,
        // The composer already started the clock when it sent, and the ~2s of session
        // setup before the agent starts is part of the wait. Overwriting it here made
        // the elapsed time jump backwards. A turn driven from the phone or the
        // scheduler has no composer, so it starts the clock here instead.
        turnStartedAt: get().turnStartedAt ?? Date.now(),
        turnTokens: 0,
      });
      break;

    case "message_start": {
      const messages = get().messages;

      // The composer already painted this one; swap in the stored copy rather than
      // showing it twice. Matched by reference, so sending the same text again is
      // still two messages.
      const pending = get().pendingUserMessage;
      if (
        event.message.role === "user" &&
        pending &&
        messages.includes(pending)
      ) {
        set({
          messages: messages.map((m) => (m === pending ? event.message : m)),
          pendingUserMessage: null,
        });
        break;
      }

      // A message_start for a message already in the list happens on reconnect; ignore it.
      if (
        event.message.role === "assistant" &&
        messages[messages.length - 1]?.role === "assistant"
      ) {
        const last = messages[messages.length - 1];
        if (last.role === "assistant" && last.stopReason === "pending") break;
      }
      set({ messages: [...messages, event.message] });
      break;
    }

    case "message_update": {
      // Held until the next frame; see `coalesce`. The newest update is the only one worth having.
      coalesce(() => {
        const messages = [...get().messages];
        const index = messages.length - 1;
        if (index >= 0 && messages[index].role === "assistant") messages[index] = event.message;
        else messages.push(event.message);
        set({ messages });
      });
      break;
    }

    case "message_end": {
      const messages = [...get().messages];

      /*
       * The composer's copy is still standing in for this one.
       *
       * `message_start` normally swaps it out, but on a brand-new conversation that event
       * arrives before `sessions.create` has returned — so the store does not yet know which
       * session it belongs to and drops it. Without this, the stored copy is appended next to
       * the copy the composer painted and the message appears twice, every first message.
       */
      const pending = get().pendingUserMessage;
      if (event.message.role === "user" && pending && messages.includes(pending)) {
        set({
          messages: messages.map((m) => (m === pending ? event.message : m)),
          pendingUserMessage: null,
        });
        break;
      }

      const index = findMessageSlot(messages, event.message);
      if (index >= 0) messages[index] = event.message;
      else messages.push(event.message);
      set({
        messages,
        // Usage lands on the finished message; a turn with several tool rounds bills
        // once per assistant reply, so they accumulate.
        turnTokens:
          event.message.role === "assistant"
            ? get().turnTokens + event.message.usage.total
            : get().turnTokens,
      });
      break;
    }

    case "tool_start":
    case "tool_update":
    case "tool_end":
      applyToolEvent(event, set, get);
      break;

    case "approval_request":
      set({
        approvals: [
          ...get().approvals,
          {
            id: event.requestId,
            kind: event.kind,
            title: event.title,
            detail: event.detail,
            ...(event.reason ? { reason: event.reason } : {}),
            subject: event.subject,
          },
        ],
      });
      break;

    case "rewound":
      // The agent discarded a tail of history; match it exactly rather than guessing
      // from the messages that arrive next.
      set({ messages: get().messages.slice(0, event.messageCount) });
      break;

    case "title": {
      // Rename in place: the list is sorted by recency and this is not a new use.
      const meta = get().meta;
      set({
        meta: meta ? { ...meta, title: event.title } : meta,
        sessions: get().sessions.map((s) =>
          s.id === sessionId ? { ...s, title: event.title } : s,
        ),
      });
      break;
    }

    case "tasks":
      // Reached only for the session on screen, which is the one whose queue is shown.
      useSide.getState().setTasks(event.tasks);
      break;

    case "retry":
      // Stamped on arrival: the delay is counted from now, and the countdown reads the clock.
      set({
        retrying: {
          attempt: event.attempt,
          until: Date.now() + event.delayMs,
          reason: event.reason,
          resume: event.resume === true,
        },
        /*
         * A resume arrives after `agent_end`, which has already stood the window down.
         *
         * Leaving it down would give a minute of blank, idle-looking window between a turn that
         * visibly failed and one that silently starts again — the exact stretch during which the
         * user concludes it is dead and starts over by hand. The turn is not over; put the line
         * back and let it count.
         */
        ...(event.resume
          ? { running: true, turnStartedAt: get().turnStartedAt ?? Date.now() }
          : {}),
      });
      break;

    case "compacted":
      /*
       * A marker in the transcript, not a toast.
       *
       * Everything above this point is a summary as far as the model is concerned. That is a
       * property of the conversation and belongs in it — a notice would say it once and then
       * take the explanation away with it.
       */
      set({
        compactions: [
          ...get().compactions,
          { at: get().messages.length, before: event.before, after: event.after },
        ],
      });
      break;

    case "notice":
      set({
        notices: [
          ...get().notices,
          {
            id: `${Date.now()}-${Math.random()}`,
            level: event.level,
            message: event.message,
          },
        ],
      });
      break;

    case "agent_end": {
      /*
       * Settled first, then read — in that order, because the answer depends on it.
       *
       * `settleTail` is what turns the half-written reply into an `aborted` one; asking the old
       * list how the turn stopped would be asking a message that still says `pending`.
       */
      const settled = settleTail(get().messages, event);
      set({
        running: false,
        retrying: null,
        approvals: [],
        pendingUserMessage: null,
        turnStartedAt: null,
        messages: settled,
        stopped: howItStopped(settled, event.reason),
      });
      void window.lyra.sessions
        .list()
        .then((sessions) => set({ sessions }));
      break;
    }
  }
}

/** Match an incoming final message to the slot its streaming version occupies. */
function findMessageSlot(messages: Message[], incoming: Message): number {
  if (incoming.role === "toolResult") {
    return messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === incoming.toolCallId);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (candidate.role !== incoming.role) continue;
    if (candidate.role === "assistant" && incoming.role === "assistant") {
      // The streamed placeholder is the only assistant message still pending.
      if (candidate.stopReason === "pending" || candidate.timestamp === incoming.timestamp) return i;
      return -1;
    }
    if (candidate.timestamp === incoming.timestamp) return i;
  }
  return -1;
}