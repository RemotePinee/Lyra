/**
 * Saying something, and everything that follows from it.
 *
 * Sending, editing, retrying, interrupting. The composer's copy of a message is painted before
 * anything is stored — a conversation that swallows what you typed for two seconds while a session
 * is created reads as broken — and the stored copy replaces it when the runtime confirms it.
 */

import type { ApprovalDecision, Message, UserContent } from "@deepwise/core";
import { without } from "./derive.ts";
import type { AppState } from "../store.ts";

type Get = () => AppState;
type Set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

export function turnSlice(set: Set, get: Get) {
  return {
  async send(content: UserContent[]) {
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
  async retryFrom(index: number) {
    const messages = get().messages;
    for (let i = Math.min(index, messages.length - 1); i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user" && !message.synthetic) {
        await get().editMessage(i, message.content);
        return;
      }
    }
  },

  async editMessage(index: number, content: UserContent[]) {
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

  async respondToApproval(id: string, decision: ApprovalDecision) {
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
  async setModel(modelId: string) {
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
  };
}

