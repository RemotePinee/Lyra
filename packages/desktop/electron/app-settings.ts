/**
 * The app's settings, in one place that owns them.
 *
 * They were a mutable module variable that six different files assigned to, which meant a change
 * could take effect in some of the places that care and not the others — a saved model that live
 * sessions never heard about, sync left running after being switched off. Here there is one setter,
 * and applying a change is one thing that either happens completely or not at all.
 *
 * `subscribe` exists because the parts that must react are not all reachable from here: the window
 * belongs to Electron, live sessions belong to the hub, sync to the server. They register what to
 * do; this decides when.
 */

import { loadSettings, migrateSecrets, saveSettings as persist, type Settings } from "@lyra/core";

type Listener = (next: Settings) => void | Promise<void>;

let current: Settings | undefined;
const listeners: Listener[] = [];

export async function loadAppSettings(): Promise<Settings> {
	/*
	 * Move any API key still written into `settings.json` out of it, before anything reads it.
	 *
	 * `saveSettings` does this on every write, so a key would move the next time anything was
	 * changed — but somebody who never opens the settings page would keep theirs in a plaintext,
	 * world-readable file forever. Here it happens once, on the first launch after updating, and is
	 * a no-op on every launch after that.
	 *
	 * Failures are swallowed on purpose: a profile on a read-only volume, or a home directory
	 * somebody has made undeletable, must not stop the app from starting over a hygiene task.
	 */
	await migrateSecrets().catch(() => 0);
	current = await loadSettings();
	return current;
}

/**
 * The settings, or undefined before boot has read them.
 *
 * Undefined rather than a default, because a default here would be a second source of truth for
 * every field — and the one place it is genuinely needed (the window's first frame) already knows
 * how to fall back.
 */
export function getSettings(): Settings | undefined {
	return current;
}

/** The settings, asserted to exist. For code that only ever runs after boot. */
export function settings(): Settings {
	if (!current) throw new Error("settings read before boot");
	return current;
}

export function onSettingsChanged(listener: Listener): () => void {
	listeners.push(listener);
	return () => {
		const at = listeners.indexOf(listener);
		if (at >= 0) listeners.splice(at, 1);
	};
}

/**
 * Change the settings: in memory, on disk, and everywhere that cares.
 *
 * The in-memory value moves first so that a listener reading `settings()` sees the new one, which
 * is what anything reacting to the change would expect.
 */
export async function applySettings(next: Settings): Promise<Settings> {
	current = next;
	await persist(next);
	for (const listener of listeners) await listener(next);
	return next;
}
