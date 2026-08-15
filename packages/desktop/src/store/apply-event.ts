/**
 * Folding an agent event into the store.
 *
 * The largest thing the store does, and the one most worth reading on its own: every event the
 * runtime emits arrives here, for every conversation at once — including the ones nobody is
 * looking at. Which is why it starts by updating per-session activity and only then asks whether
 * the event belongs to the conversation on screen.
 */

import type { AgentEvent, Message, TodoItem } from "@deepwise/core";
import { nextActivity } from "@deepwise/core/activity";
import { useSide } from "../sideStore.ts";
import type { AppState } from "../store.ts";
import { settleTail } from "../transcript.ts";

type Get = () => AppState;
type Set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

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
    const next = nextActivity(event, current);
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
      void window.deepwise.sessions
        .list()
        .then((sessions) => set({ sessions }));
    }
    return;
  }

  switch (event.type) {
    case "agent_start":
      set({
        running: true,
        retrying: null,
        interrupted: false,
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
      const messages = [...get().messages];
      const index = messages.length - 1;
      if (index >= 0 && messages[index].role === "assistant")
        messages[index] = event.message;
      else messages.push(event.message);
      set({ messages });
      break;
    }

    case "message_end": {
      const messages = [...get().messages];
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
      set({
        toolRuns: {
          ...get().toolRuns,
          [event.toolCallId]: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            summary: event.summary,
            args: event.args,
            status: "running",
            startedAt: Date.now(),
          },
        },
      });
      break;

    case "tool_update": {
      const run = get().toolRuns[event.toolCallId];
      if (run)
        set({
          toolRuns: {
            ...get().toolRuns,
            [event.toolCallId]: { ...run, result: event.partial },
          },
        });
      break;
    }

    case "tool_end": {
      const run = get().toolRuns[event.toolCallId];
      set({
        toolRuns: {
          ...get().toolRuns,
          [event.toolCallId]: {
            ...(run ?? {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              summary: event.toolName,
              args: {},
              startedAt: Date.now(),
            }),
            status: event.isError ? "error" : "done",
            result: event.result,
            finishedAt: Date.now(),
          },
        },
      });
      // The task list arrives as the result of writing it; nothing else announces it.
      const written = event.result.details as { kind?: string; todos?: TodoItem[] } | undefined;
      if (!event.isError && written?.kind === "todo" && Array.isArray(written.todos)) {
        set({ todos: written.todos });
      }
      break;
    }

    case "approval_request":
      set({
        approvals: [
          ...get().approvals,
          {
            id: event.requestId,
            kind: event.kind,
            title: event.title,
            detail: event.detail,
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
      set({ retrying: { attempt: event.attempt, delayMs: event.delayMs, reason: event.reason } });
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

    case "agent_end":
      set({
        running: false,
        retrying: null,
        approvals: [],
        pendingUserMessage: null,
        turnStartedAt: null,
        messages: settleTail(get().messages, event),
      });
      void window.deepwise.sessions
        .list()
        .then((sessions) => set({ sessions }));
      break;
  }
}

/** Match an incoming final message to the slot its streaming version occupies. */
export function findMessageSlot(messages: Message[], incoming: Message): number {
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
