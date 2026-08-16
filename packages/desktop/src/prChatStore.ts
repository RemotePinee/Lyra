/**
 * The conversation about one pull request.
 *
 * A separate store from the main one for the same reason the side chat has its own: these replies
 * must never land in the workspace transcript. Reviewing somebody's branch and working on your own
 * project are two different threads of thought, and the app should not merge them because they
 * happened to be open at the same time.
 *
 * Underneath it is an ordinary session — the same `agent:*` calls the main conversation uses, with
 * the same tools, approvals and streaming. The only thing unusual is where it runs: a scratch
 * directory under the app's home rather than a project. That is what "the agent does not have to
 * be in a project" means in practice, and it is what makes this work for a pull request in a
 * repository that has never been cloned here.
 *
 * Sessions are stored by a hash of their directory and the directory is derived from the pull
 * request, so reopening one months later finds the same conversation with nothing kept on the side
 * to make that true.
 */

import type { AgentEvent, Message, SessionMeta } from "@lyra/core";
import { create } from "zustand";
import type { PullRequestDetail } from "../electron/ipc-types.ts";

const key = (repo: string, number: number) => `${repo}#${number}`;

/** Opens the sentence prefixed to the first question. Kept in one place, used from two. */
const BRIEF_PREFIX = "（这是对 GitHub Pull Request ";
const BRIEF_END = "）\n\n";

function brief(id: string): string {
	return `${BRIEF_PREFIX}${id} 的讨论。工作目录下的 PR.md 有它的标题、分支、状态和描述；需要改动内容时用 gh pr diff。${BRIEF_END}`;
}

/**
 * Take the brief back off a stored message.
 *
 * The transcript on disk is what the model was sent, prefix and all — that is the honest record
 * and it should stay that way. But reading it back means showing the user a paragraph explaining
 * a pull request they are already looking at, above the one line they actually wrote. So it is
 * removed on the way out rather than never written: the log stays true, the conversation stays
 * readable.
 */
function stripBrief(message: Message): Message {
	if (message.role !== "user") return message;
	let changed = false;
	const content = message.content.map((part) => {
		if (part.type !== "text" || !part.text.startsWith(BRIEF_PREFIX)) return part;
		const end = part.text.indexOf(BRIEF_END);
		if (end < 0) return part;
		changed = true;
		return { ...part, text: part.text.slice(end + BRIEF_END.length) };
	});
	return changed ? { ...message, content } : message;
}

interface PrChatState {
	/** Which pull request is loaded, so a stale reply can be told from a current one. */
	key: string | null;
	sessionId: string | null;
	messages: Message[];
	running: boolean;
	loading: boolean;
	error: string | null;
	/** Whether this conversation has already been told what it is about. */
	briefed: boolean;
	/**
	 * A question asked before the session existed.
	 *
	 * The 审查 button can be pressed while the conversation is still being opened — the directory
	 * has to be prepared and the transcript read first — and sending into a session that is not
	 * there yet silently does nothing. Held here and sent by the panel once there is somewhere for
	 * it to go, which also covers the case where the button is what opens the tab.
	 */
	pendingAsk: string | null;
	/**
	 * Whether the next user message on the wire is our own question coming back.
	 *
	 * A flag rather than comparing text: what echoes carries the brief prefixed to it, so it is
	 * not the same string, and matching on a suffix would also fold together two identical
	 * questions asked in a row.
	 */
	expectingEcho: boolean;

	open(detail: PullRequestDetail): Promise<void>;
	/** Ask as soon as the conversation is ready, which may be immediately. */
	queueAsk(text: string): void;
	ask(text: string): Promise<void>;
	abort(): Promise<void>;
	applyEvent(sessionId: string, event: AgentEvent): void;
}

const EMPTY = {
	sessionId: null,
	messages: [] as Message[],
	running: false,
	error: null as string | null,
	briefed: false,
	pendingAsk: null as string | null,
	expectingEcho: false,
};

export const usePrChat = create<PrChatState>((set, get) => ({
	key: null,
	loading: false,
	...EMPTY,

	async open(detail) {
		const id = key(detail.repo, detail.number);
		if (get().key === id) return;

		set({ key: id, loading: true, ...EMPTY });
		try {
			const cwd = await window.lyra.git.openPrChat({
				repo: detail.repo,
				number: detail.number,
				title: detail.title,
				author: detail.author,
				url: detail.url,
				headRefName: detail.headRefName,
				baseRefName: detail.baseRefName,
				state: detail.state,
				body: detail.body,
			});

			// Selection can move while GitHub is answering; a late reply must not overwrite it.
			if (get().key !== id) return;

			const existing = await findSession(cwd);
			const snapshot = existing
				? await window.lyra.sessions.open(existing.projectId, existing.id)
				: await window.lyra.sessions.create(cwd, "");

			if (get().key !== id) return;
			set({
				sessionId: snapshot?.meta.id ?? null,
				messages: (snapshot?.messages ?? []).map(stripBrief),
				// A conversation that already has messages has been briefed; a fresh one has not.
				briefed: (snapshot?.messages.length ?? 0) > 0,
				loading: false,
			});
		} catch (error) {
			if (get().key !== id) return;
			set({ loading: false, error: error instanceof Error ? error.message : String(error) });
		}
	},

	queueAsk(text) {
		set({ pendingAsk: text });
	},

	async ask(text) {
		const { sessionId, running, briefed, key: current } = get();
		const body = text.trim();
		if (!sessionId || running || !body) return;

		/*
		 * The first question carries a sentence saying what is being discussed.
		 *
		 * Short on purpose. The facts are in `PR.md` in the working directory and the diff is a
		 * `gh` call away, so this only has to point at both — pasting the description and the
		 * patch into every new conversation would put somebody else's change above the question
		 * the user actually asked, and pay for it again on each one.
		 */
		const prefix = !briefed && current ? brief(current) : "";

		// Painted immediately, and kept — see `message_start` for why the echo is dropped instead.
		const pending: Message = { role: "user", content: [{ type: "text", text: body }], timestamp: Date.now() };
		set({
			messages: [...get().messages, pending],
			running: true,
			error: null,
			briefed: true,
			expectingEcho: true,
		});

		await window.lyra.agent.prompt(sessionId, [{ type: "text", text: prefix + body }]);
	},

	async abort() {
		const { sessionId } = get();
		if (sessionId) await window.lyra.agent.abort(sessionId);
	},

	applyEvent(sessionId, event) {
		// Every session broadcasts on one channel; this one only draws its own.
		if (sessionId !== get().sessionId) return;

		switch (event.type) {
			case "agent_start":
				set({ running: true });
				break;

			case "agent_end":
				// Clears the flag as well: a turn that failed before the question was recorded would
				// otherwise leave it armed, and swallow the next question the user typed.
				set({ running: false, expectingEcho: false });
				break;

			case "message_start": {
				/*
				 * Our own question, coming back with the brief prefixed to it — dropped rather than
				 * drawn.
				 *
				 * The obvious move is to swap the painted copy for this one, since it is what the
				 * model actually received. But what the model received opens with a paragraph
				 * explaining which pull request this is, and showing that buries the one line the
				 * user actually wrote. The prefix is addressed to the model; it does not belong in
				 * a transcript of the conversation.
				 */
				if (event.message.role === "user" && get().expectingEcho) {
					set({ expectingEcho: false });
					break;
				}
				set({ messages: [...get().messages, event.message] });
				break;
			}

			case "message_update":
			case "message_end": {
				const messages = [...get().messages];
				const index = messages.length - 1;
				if (index >= 0 && messages[index].role === "assistant") messages[index] = event.message;
				else messages.push(event.message);
				set({ messages });
				break;
			}

			case "notice":
				if (event.level === "error") set({ error: event.message, running: false });
				break;

			default:
				break;
		}
	},
}));

/** The most recent session in this directory, or null if the conversation has not started. */
async function findSession(cwd: string): Promise<SessionMeta | null> {
	const sessions = await window.lyra.sessions.list();
	return (
		sessions
			.filter((session) => session.cwd === cwd && !session.archived)
			.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
	);
}
