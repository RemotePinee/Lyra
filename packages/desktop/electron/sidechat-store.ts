/**
 * The side chat, kept across restarts.
 *
 * It used to be memory only, and the empty panel said so: 「临时对话，关闭应用后消失」. That is a
 * reasonable bargain for two questions about what just happened, and a bad one by the time you have
 * spent ten minutes in it and dispatched work from it — closing the app, or losing it to a crash,
 * took the whole thread with no warning beyond a sentence read once, weeks ago.
 *
 * One file per main session, beside the sessions themselves. Whole-file writes rather than a log:
 * these conversations are short, they are rewritten rather than appended to when a question is
 * edited, and nothing else reads them.
 *
 * Failures are swallowed on purpose. A side chat that cannot be saved is worth less than the main
 * conversation it comments on, and it must never be the reason a turn reports an error.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lyraHome, type Message } from "@lyra/core";

function dir(): string {
	return join(lyraHome(), "sidechats");
}

function fileFor(sessionId: string): string {
	// The id comes from the session store and is a UUID; nothing else is interpolated.
	return join(dir(), `${sessionId}.json`);
}

/** What was said in this session's side chat last time, or an empty list. */
export async function loadSideChat(sessionId: string): Promise<Message[]> {
	const raw = await readFile(fileFor(sessionId), "utf8").catch(() => null);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as { messages?: Message[] };
		return Array.isArray(parsed.messages) ? parsed.messages : [];
	} catch {
		// A truncated write from a crash. Losing this conversation is better than refusing to open
		// the panel because of it.
		return [];
	}
}

/**
 * Write it out.
 *
 * Write-then-rename, so a crash midway leaves the previous version rather than half of this one.
 */
export async function saveSideChat(sessionId: string, messages: Message[]): Promise<void> {
	try {
		if (messages.length === 0) {
			await rm(fileFor(sessionId), { force: true });
			return;
		}
		await mkdir(dir(), { recursive: true });
		const tmp = `${fileFor(sessionId)}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify({ messages }), "utf8");
		const { rename } = await import("node:fs/promises");
		await rename(tmp, fileFor(sessionId));
	} catch {
		// See the note at the top: never the reason a turn fails.
	}
}

/** Forget it, because the user asked for a clean panel. */
export async function clearSideChat(sessionId: string): Promise<void> {
	await rm(fileFor(sessionId), { force: true }).catch(() => {});
}
