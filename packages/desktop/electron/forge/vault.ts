/**
 * Where the accounts and their tokens are kept.
 *
 * This app avoided being a credential store for as long as it could — `gh` held the token, and
 * that was one less thing to be responsible for. Supporting four hosts and several identities ends
 * that: there is no CLI that holds a GitLab token and a Gitee token and a token for the company's
 * own Gitea, and asking somebody to install three of them would be worse than storing one.
 *
 * So it is stored, and the storage does the three things that make that defensible:
 *
 * - The token is encrypted by the OS keychain (`safeStorage`), not by a key in this repository.
 *   On macOS that is the Keychain, on Windows DPAPI, on Linux whatever keyring is running.
 * - It is written `0600`, in the app's own directory, never in `settings.json` — which is synced,
 *   copied between machines and pasted into bug reports.
 * - It never crosses IPC. The renderer gets accounts without tokens; every call that needs one is
 *   made here.
 *
 * When the OS has no keyring at all — a bare Linux box, which is a real case — the alternative to
 * storing it unencrypted is refusing to work. It stores it, and marks it, so the settings page can
 * say so rather than implying a protection that is not there.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lyraHome } from "@lyra/core";
import { parseAccounts } from "./accounts.ts";
import type { ForgeAccount } from "./types.ts";

interface StoredEntry {
	account: ForgeAccount;
	/** Base64 of the encrypted token, or the token itself when `encrypted` is false. */
	token: string;
	encrypted: boolean;
}

interface StoredFile {
	version: 1;
	entries: StoredEntry[];
}

const FILE = () => join(lyraHome(), "forges.json");

/** Read once, kept in memory: every list refresh would otherwise be a disk read and a decrypt. */
let loaded: StoredFile | null = null;

async function read(): Promise<StoredFile> {
	if (loaded) return loaded;
	const raw = await readFile(FILE(), "utf8").catch(() => null);
	if (!raw) return (loaded = { version: 1, entries: [] });

	try {
		const parsed = JSON.parse(raw) as { entries?: unknown[] };
		const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
		// The accounts go through the same validation as a hand-edited file, and an entry whose
		// account did not survive it is dropped along with its token — a token nobody can attribute
		// to a host is not a credential, it is a secret with no purpose.
		const kept: StoredEntry[] = [];
		for (const entry of entries as StoredEntry[]) {
			const [account] = parseAccounts([entry?.account]);
			if (account && typeof entry.token === "string") {
				kept.push({ account, token: entry.token, encrypted: entry.encrypted === true });
			}
		}
		return (loaded = { version: 1, entries: kept });
	} catch {
		return (loaded = { version: 1, entries: [] });
	}
}

async function write(file: StoredFile): Promise<void> {
	loaded = file;
	const path = FILE();
	await mkdir(lyraHome(), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
	// Before the rename, so the file is never readable by anyone else even for an instant.
	await chmod(tmp, 0o600).catch(() => {});
	await rename(tmp, path);
}

/**
 * The keychain, if this machine has one.
 *
 * Imported dynamically for the same reason as everything else here that touches Electron: this
 * module is reachable from tests, where `electron` is not a module that exists.
 */
async function keychain(): Promise<{ encrypt(value: string): Buffer; decrypt(value: Buffer): string } | null> {
	try {
		const { safeStorage } = await import("electron");
		if (!safeStorage?.isEncryptionAvailable()) return null;
		return {
			encrypt: (value) => safeStorage.encryptString(value),
			decrypt: (value) => safeStorage.decryptString(value),
		};
	} catch {
		return null;
	}
}

/** Whether tokens on this machine are protected by the OS, for the settings page to be honest. */
export async function encryptionAvailable(): Promise<boolean> {
	return (await keychain()) !== null;
}

export async function listAccounts(): Promise<ForgeAccount[]> {
	return (await read()).entries.map((entry) => entry.account);
}

export async function accountById(id: string): Promise<ForgeAccount | null> {
	return (await read()).entries.find((entry) => entry.account.id === id)?.account ?? null;
}

/** The secret for one account, decrypted. Null when there is no such account. */
export async function tokenFor(id: string): Promise<string | null> {
	const entry = (await read()).entries.find((e) => e.account.id === id);
	if (!entry) return null;
	if (!entry.encrypted) return entry.token;

	const vault = await keychain();
	if (!vault) return null;
	try {
		return vault.decrypt(Buffer.from(entry.token, "base64"));
	} catch {
		/*
		 * Written on another machine, or after the keychain entry was removed.
		 *
		 * Null rather than a throw: the caller turns it into "this account needs signing in again",
		 * which is both true and actionable, where a decryption stack trace is neither.
		 */
		return null;
	}
}

/** Save an account and its token, replacing whatever was filed under the same id. */
export async function saveAccount(account: ForgeAccount, token: string): Promise<void> {
	const file = await read();
	const vault = await keychain();
	const entry: StoredEntry = vault
		? { account, token: vault.encrypt(token).toString("base64"), encrypted: true }
		: { account, token, encrypted: false };

	const at = file.entries.findIndex((e) => e.account.id === account.id);
	const entries = [...file.entries];
	if (at < 0) entries.push(entry);
	else entries[at] = entry;
	await write({ version: 1, entries });
}

/** Change what is known about an account without touching its token. */
export async function updateAccount(id: string, patch: Partial<ForgeAccount>): Promise<ForgeAccount | null> {
	const file = await read();
	const at = file.entries.findIndex((e) => e.account.id === id);
	if (at < 0) return null;

	const account = { ...file.entries[at].account, ...patch, id };
	const entries = [...file.entries];
	entries[at] = { ...file.entries[at], account };
	await write({ version: 1, entries });
	return account;
}

export async function removeAccount(id: string): Promise<void> {
	const file = await read();
	const entries = file.entries.filter((entry) => entry.account.id !== id);
	if (entries.length !== file.entries.length) await write({ version: 1, entries });
}
