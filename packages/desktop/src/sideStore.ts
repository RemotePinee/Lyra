/**
 * State for the side chat and the task queue.
 *
 * Kept apart from the main store because it is a different conversation with a different
 * lifetime: this one lives in memory, dies with the app, and never reaches the session log.
 * Folding it into the main store would put two transcripts behind one set of message fields
 * and invite exactly the bug that makes a side-chat reply appear in the main thread.
 */

import type { AgentEvent, Message, QueuedTask, UserContent } from "@deepwise/core";
import { create } from "zustand";
import { summarizeToolCall } from "./toolSummary.ts";
import type { ToolRun } from "./store.ts";
import { settleTail } from "./transcript.ts";

/** What can occupy a panel tab. One of each at a time — two diffs of one worktree is not a thing. */
export type PanelKind = "files" | "chat" | "terminal" | "review" | "browser" | "tasks" | "trajectory";

/** Just enough of a preview for the panel to load it; the card owns the full record. */
export interface BrowserPreview {
	id: string;
	sessionId: string;
	title: string;
	entry: string;
}

interface SideState {
	/**
	 * The panel is a tab strip, not a single slot.
	 *
	 * Several things are open at once and you flick between them, the way you would between
	 * browser tabs. A dropdown that swapped the panel's contents made every switch cost two
	 * clicks and lost the sense that the other thing is still there.
	 */
	tabs: PanelKind[];
	activeTab: PanelKind | null;
	/**
	 * Visible or not, kept apart from `tabs`.
	 *
	 * Collapsing the panel is "give me the width back", not "throw this away" — so the tabs
	 * survive it and come back on the next open. Closing a tab's ✕ is the one that discards.
	 */
	panelOpen: boolean;
	/** Second width, for when a diff needs more room than the default 520. */
	expanded: boolean;

	/** The session this state belongs to, so a late event from the previous one is discarded. */
	sessionId: string | null;
	messages: Message[];
	toolRuns: Record<string, ToolRun>;
	running: boolean;
	/** Painted before the round trip, replaced by the stored copy when it arrives. */
	pending: Message | null;
	tasks: QueuedTask[];

	/** Focus this kind, adding a tab for it if there is not one already. */
	openTab(kind: PanelKind): void;
	/**
	 * A command the user asked to run, waiting for the terminal to pick it up.
	 *
	 * Handed over rather than executed here: the pty belongs to the terminal pane, which may not
	 * exist yet when the button is pressed. The pane clears this once it has written it, so the
	 * same command is never run twice.
	 */
	pendingCommand: string | null;
	runInTerminal(command: string): void;
	commandTaken(): void;
	/**
	 * What the browser tab is showing.
	 *
	 * A preview handed over from the transcript, a URL typed into the address bar, or nothing.
	 * Held here rather than inside the panel so "open this in the side panel" can be a single
	 * call from a card that knows nothing about how the panel is built.
	 */
	browserTarget: { kind: "preview"; preview: BrowserPreview } | { kind: "url"; url: string } | null;
	openPreview(preview: BrowserPreview): void;
	openUrl(url: string): void;
	/** Discard a tab. Closing the last one puts the panel away. */
	closeTab(kind: PanelKind): void;
	/**
	 * Show the panel again with whatever it held last.
	 *
	 * Deliberately opens empty when there is nothing to restore — the chooser is the panel's
	 * real first screen, not a fallback. Guessing a tab means guessing wrong half the time and
	 * making you close something you did not ask for.
	 */
	reopenPanel(): void;
	closePanel(): void;
	/** Shortcut behaviour: focus it, or put the panel away if it is already the one in front. */
	toggleTab(kind: PanelKind): void;
	toggleExpanded(): void;

	/** Point at a session and pull whatever conversation it already has. */
	attach(sessionId: string | null): Promise<void>;
	ask(content: UserContent[]): Promise<void>;
	abort(): Promise<void>;
	reset(): Promise<void>;
	cancelTask(taskId: string): Promise<void>;
	applyEvent(sessionId: string, event: AgentEvent): void;
	setTasks(tasks: QueuedTask[]): void;
}

const EMPTY = {
	messages: [] as Message[],
	toolRuns: {} as Record<string, ToolRun>,
	running: false,
	pending: null as Message | null,
	tasks: [] as QueuedTask[],
};

export const useSide = create<SideState>((set, get) => ({
	tabs: [],
	activeTab: null,
	panelOpen: false,
	browserTarget: null,
	expanded: false,
	sessionId: null,
	...EMPTY,

	openPreview: (preview) => set({ browserTarget: { kind: "preview", preview } }),
	openUrl: (url) => set({ browserTarget: { kind: "url", url } }),
	pendingCommand: null,
	runInTerminal: (command) => {
		set({ pendingCommand: command });
		get().openTab("terminal");
	},
	commandTaken: () => set({ pendingCommand: null }),

	openTab: (kind) => {
		const tabs = get().tabs.includes(kind) ? get().tabs : [...get().tabs, kind];
		set({ tabs, activeTab: kind, panelOpen: true });
	},

	/**
	 * Discard a tab. The panel stays.
	 *
	 * Closing the last one lands on the chooser rather than dismissing the panel. `✕` closes a
	 * tab and `◨` puts the panel away; if `✕` sometimes did both, the same gesture would mean
	 * two different things depending on how many tabs happened to be open.
	 */
	closeTab: (kind) => {
		const tabs = get().tabs.filter((t) => t !== kind);
		// Land on a neighbour rather than on nothing: closing the front tab should reveal what
		// was behind it, not send you back to the chooser with something still open.
		const wasActive = get().activeTab === kind;
		set({ tabs, activeTab: tabs.length === 0 ? null : wasActive ? tabs[tabs.length - 1] : get().activeTab });
	},

	reopenPanel: () => {
		const tabs = get().tabs;
		set({ panelOpen: true, activeTab: tabs.length > 0 ? (get().activeTab ?? tabs[0]) : null });
	},

	closePanel: () => set({ panelOpen: false }),

	toggleTab: (kind) => {
		if (get().panelOpen && get().activeTab === kind) {
			set({ panelOpen: false });
			return;
		}
		get().openTab(kind);
	},

	toggleExpanded: () => set({ expanded: !get().expanded }),

	async attach(sessionId) {
		if (get().sessionId === sessionId) return;
		set({ sessionId, ...EMPTY });
		if (!sessionId) return;

		const [state, tasks] = await Promise.all([
			window.deepwise.sideChat.state(sessionId),
			window.deepwise.tasks.list(sessionId),
		]);
		// A second switch while this was in flight wins.
		if (get().sessionId !== sessionId) return;
		set({
			messages: state?.messages ?? [],
			running: state?.running ?? false,
			toolRuns: state ? rebuildToolRuns(state.messages) : {},
			tasks,
		});
	},

	async ask(content) {
		const sessionId = get().sessionId;
		if (!sessionId || get().running) return;

		/*
		 * Paint it first.
		 *
		 * The first question of a session activates the main agent behind the scenes, which
		 * takes a second or more. Without this the composer would clear and nothing would take
		 * its place for that whole time.
		 */
		const pending: Message = { role: "user", content, timestamp: Date.now() };
		set({ messages: [...get().messages, pending], pending, running: true });
		await window.deepwise.sideChat.ask(sessionId, content);
	},

	async abort() {
		const sessionId = get().sessionId;
		if (sessionId) await window.deepwise.sideChat.abort(sessionId);
		set({ running: false });
	},

	async reset() {
		const sessionId = get().sessionId;
		set({ ...EMPTY, tasks: get().tasks });
		if (sessionId) await window.deepwise.sideChat.reset(sessionId);
	},

	async cancelTask(taskId) {
		const sessionId = get().sessionId;
		if (!sessionId) return;
		// Optimistic: the card should stop saying "queued" on the click, not on the round trip.
		set({
			tasks: get().tasks.map((t) => (t.id === taskId && t.status === "queued" ? { ...t, status: "cancelled" } : t)),
		});
		await window.deepwise.tasks.cancel(sessionId, taskId);
	},

	setTasks: (tasks) => set({ tasks }),

	applyEvent(sessionId, event) {
		// Events from a session we have since navigated away from would paint into the wrong
		// conversation.
		if (sessionId !== get().sessionId) return;

		switch (event.type) {
			case "agent_start":
				set({ running: true });
				break;

			case "message_start": {
				const messages = get().messages;
				// The composer already painted this one; swap in the real copy rather than
				// showing it twice. Matched by reference, so asking the same thing twice is
				// still two messages.
				const pending = get().pending;
				if (event.message.role === "user" && pending && messages.includes(pending)) {
					set({ messages: messages.map((m) => (m === pending ? event.message : m)), pending: null });
					break;
				}
				set({ messages: [...messages, event.message] });
				break;
			}

			case "message_update": {
				const messages = [...get().messages];
				const index = messages.length - 1;
				if (index >= 0 && messages[index].role === "assistant") messages[index] = event.message;
				else messages.push(event.message);
				set({ messages });
				break;
			}

			case "message_end": {
				const messages = [...get().messages];
				const index = findSlot(messages, event.message);
				if (index >= 0) messages[index] = event.message;
				else messages.push(event.message);
				set({ messages });
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
				break;
			}

			case "agent_end":
				// Same reason as the main store: a dropped connection never sends `message_end`,
				// so the last reply would stay marked as still being written.
				set({ running: false, pending: null, messages: settleTail(get().messages, event) });
				break;
		}
	},
}));

/** Match an incoming final message to the slot its streaming version occupies. */
function findSlot(messages: Message[], incoming: Message): number {
	if (incoming.role === "toolResult") {
		return messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === incoming.toolCallId);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = messages[i];
		if (candidate.role !== incoming.role) continue;
		if (candidate.role === "assistant" && incoming.role === "assistant") {
			if (candidate.stopReason === "pending" || candidate.timestamp === incoming.timestamp) return i;
			return -1;
		}
		if (candidate.timestamp === incoming.timestamp) return i;
	}
	return -1;
}

/** Rebuild tool cards when re-attaching to a conversation that ran while the panel was closed. */
function rebuildToolRuns(messages: Message[]): Record<string, ToolRun> {
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
				run.result = { content: message.content, details: message.details, isError: message.isError };
				run.finishedAt = message.timestamp;
			}
		}
	}
	return runs;
}
