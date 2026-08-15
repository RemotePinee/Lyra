/**
 * The side chat, and the task queue it dispatches into.
 *
 * A second conversation about the same session: it can read the transcript and hand work to the
 * agent, but its own replies never join that transcript. Keeping the two apart is most of what
 * this file is for — hence its own channel prefix and its own emit path.
 */

import { ipcMain } from "electron";
import type { AgentEvent, AgentSession, Settings, UserContent } from "@lyra/core";
import { SideChat } from "@lyra/core";

export interface SideChatIpcDeps {
	sideChats: Map<string, SideChat>;
	sessions: Map<string, AgentSession>;
	settings(): Settings;
	ensureSession(sessionId: string): Promise<AgentSession | null>;
	broadcastSideChat(sessionId: string, event: AgentEvent): void;
}

export function registerSideChatIpc({ sideChats, sessions, settings, ensureSession, broadcastSideChat }: SideChatIpcDeps): void {
	/**
	 * The side chat for a session, built on first use.
	 *
	 * Building one activates the main session, because a side chat with no transcript to read
	 * is pointless — and because dispatching work needs somewhere to dispatch it to. That cost
	 * is paid on the first question, not on opening the panel.
	 */
	async function ensureSideChat(sessionId: string): Promise<SideChat | null> {
		const existing = sideChats.get(sessionId);
		if (existing) {
			existing.updateSettings(settings());
			return existing;
		}
		const main = await ensureSession(sessionId);
		if (!main) return null;
		const chat = new SideChat({ main, settings: settings(), emit: (event) => broadcastSideChat(sessionId, event) });
		sideChats.set(sessionId, chat);
		return chat;
	}

	ipcMain.handle("sidechat:state", async (_event, sessionId: string) => {
		const chat = sideChats.get(sessionId);
		return chat ? chat.state() : null;
	});

	ipcMain.handle("sidechat:ask", async (_event, sessionId: string, content: UserContent[]) => {
		const chat = await ensureSideChat(sessionId);
		if (!chat) throw new Error(`Session ${sessionId} is not open.`);
		// Not awaited, same as `agent:prompt` — the reply streams back over IPC.
		void chat.ask(content).catch((error: unknown) => {
			broadcastSideChat(sessionId, {
				type: "notice",
				level: "error",
				message: error instanceof Error ? error.message : String(error),
			});
			broadcastSideChat(sessionId, { type: "agent_end", reason: "error", error: String(error) });
		});
	});

	ipcMain.handle("sidechat:abort", async (_event, sessionId: string) => {
		sideChats.get(sessionId)?.abort();
	});

	ipcMain.handle("sidechat:reset", async (_event, sessionId: string) => {
		sideChats.get(sessionId)?.reset();
	});

	ipcMain.handle("tasks:list", async (_event, sessionId: string) => sessions.get(sessionId)?.taskQueue ?? []);

	ipcMain.handle("tasks:cancel", async (_event, sessionId: string, taskId: string) => {
		const session = sessions.get(sessionId);
		return session ? session.cancelTask(taskId) : false;
	});
}
