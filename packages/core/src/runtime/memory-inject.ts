/**
 * What goes into the prompt as memory, gathered once per turn — and recorded as having gone.
 *
 * Two stores with different scopes and different trust: the user's own preferences from
 * `~/.lyra/memory.json`, and this project's memory (what `learn` wrote, what background
 * extraction wrote). Read from disk each turn rather than cached in the session, because `learn`
 * writes the file mid-conversation and a session that cached this at startup would keep telling
 * the model it had not learned the thing it just learned.
 *
 * Pulled out of the turn so it can be tested without one: the turn is a hundred other things.
 */

import { readExtractedMemory } from "./memory-extract.ts";
import { EXTRACTED_KEY, markInjected, projectInjectedPath, userInjectedPath } from "./memory-injected.ts";
import { formatMemoryForPrompt, loadMemory } from "./memory.ts";
import { formatProjectMemory, readLessons } from "./project-memory.ts";

export interface GatheredMemory {
	/** `<user_memory>…</user_memory>`, or empty. */
	memorySnippet: string;
	/** The project's lessons and extracted memory, formatted, or empty. */
	projectMemory: string;
}

export async function gatherMemory(cwd: string, enabled: boolean, now = Date.now(), projectEnabled = enabled, recordInjection = true): Promise<GatheredMemory> {
	if (!enabled && !projectEnabled) return { memorySnippet: "", projectMemory: "" };

	let memorySnippet = "";
	let userKeys: string[] = [];
	try {
		const store = await loadMemory();
		memorySnippet = enabled ? formatMemoryForPrompt(store.entries) : "";
		userKeys = store.entries.map((entry) => entry.id);
	} catch {
		// Memory loading is resilient and silent.
	}

	const lessons = projectEnabled ? await readLessons(cwd).catch(() => []) : [];
	const extracted = projectEnabled ? await readExtractedMemory(cwd).catch(() => "") : "";
	const projectMemory = formatProjectMemory(lessons, extracted, now);
	const projectKeys = [...lessons.map((lesson) => lesson.text), ...(extracted.trim() ? [EXTRACTED_KEY] : [])];

	// Recorded, not awaited for correctness: a failed timestamp must not cost the turn.
	if (recordInjection) await Promise.all([
		memorySnippet ? markInjected(userInjectedPath(), userKeys, now).catch(() => false) : Promise.resolve(false),
		projectMemory ? markInjected(projectInjectedPath(cwd), projectKeys, now).catch(() => false) : Promise.resolve(false),
	]);

	return { memorySnippet, projectMemory };
}
