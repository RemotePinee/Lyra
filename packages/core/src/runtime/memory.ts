/**
 * Persistent memory engine: stores learned facts, preferences, user habits, and rules across sessions.
 * Similar to OpenAI / Codex local memory model, saved under ~/.lyra/memory.json.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lyraHome } from "../session/store.ts";

export interface MemoryEntry {
	id: string;
	content: string;
	createdAt: number;
	updatedAt: number;
	source?: "user" | "auto" | "session";
	sessionId?: string;
}

export interface MemoryStore {
	version: 1;
	entries: MemoryEntry[];
	lastUpdatedAt: number;
}

const DEFAULT_MEMORY_STORE: MemoryStore = {
	version: 1,
	entries: [],
	lastUpdatedAt: Date.now(),
};

export function memoryPath(): string {
	return join(lyraHome(), "memory.json");
}

export async function loadMemory(): Promise<MemoryStore> {
	const p = memoryPath();
	const raw = await readFile(p, "utf8").catch(() => null);
	if (!raw) return { ...DEFAULT_MEMORY_STORE, entries: [] };
	try {
		const parsed = JSON.parse(raw) as Partial<MemoryStore>;
		return {
			version: 1,
			entries: Array.isArray(parsed.entries) ? parsed.entries : [],
			lastUpdatedAt: parsed.lastUpdatedAt ?? Date.now(),
		};
	} catch {
		return { ...DEFAULT_MEMORY_STORE, entries: [] };
	}
}

export async function saveMemory(store: MemoryStore): Promise<void> {
	const p = memoryPath();
	await mkdir(dirname(p), { recursive: true });
	const data = JSON.stringify(
		{
			version: 1,
			entries: store.entries,
			lastUpdatedAt: Date.now(),
		},
		null,
		2,
	);
	await writeFile(p, data, "utf8");
}

export async function addMemoryEntry(content: string, source: "user" | "auto" | "session" = "user", sessionId?: string): Promise<MemoryEntry> {
	const trimmed = content.trim();
	if (!trimmed) throw new Error("Memory content cannot be empty");
	const store = await loadMemory();
	const entry: MemoryEntry = {
		id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
		content: trimmed,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		source,
		sessionId,
	};
	store.entries.unshift(entry);
	await saveMemory(store);
	return entry;
}

export async function removeMemoryEntry(id: string): Promise<boolean> {
	const store = await loadMemory();
	const initial = store.entries.length;
	store.entries = store.entries.filter((e) => e.id !== id);
	if (store.entries.length !== initial) {
		await saveMemory(store);
		return true;
	}
	return false;
}

export async function clearAllMemory(): Promise<void> {
	await saveMemory({
		version: 1,
		entries: [],
		lastUpdatedAt: Date.now(),
	});
}

/** Formats memory entries for insertion into the agent's system prompt. */
export function formatMemoryForPrompt(entries: MemoryEntry[]): string {
	if (entries.length === 0) return "";
	const list = entries.map((e) => `- ${e.content}`).join("\n");
	return `<user_memory>\nRelevant user preferences, facts, and persistent memory learned across sessions:\n${list}\n</user_memory>`;
}
