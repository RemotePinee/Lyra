/**
 * Where the accounts and their tokens are kept.
 *
 * This app avoided being a credential store for as long as it could — `gh` held the token, and
 * that was one less thing to be responsible for. Supporting four hosts and several identities ends
 * that: there is no CLI that holds a GitLab token and a Gitee token and a token for the company's
 * own Gitea, and asking somebody to install three of them would be worse than storing one.
 *
 * The token used to be encrypted by the OS keychain, and is not any more. That was the right
 * default and the wrong one for how this app is shipped: the macOS builds are ad-hoc signed, so
 * every release has a different code identity, and a keychain entry is bound to the identity that
 * created it. The effect was signing in to GitHub again after every single update. See
 * `config/vault.ts` in core for the measurement and the trade that replaces it.
 *
 * What still holds:
 *
 * - The token is never in `settings.json` — the file that is synced, copied between machines and
 *   pasted into bug reports.
 * - Both the token and the key that seals it are `0600`, in the app's own directory.
 * - It never crosses IPC. The renderer gets accounts without tokens; every call that needs one is
 *   made here.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lyraHome } from "@lyra/core";
import { isSealed, seal, unseal } from "@lyra/core";
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

/**
 * Forget what was read, for tests that point `LYRA_HOME` somewhere else between cases.
 *
 * The cache is keyed on nothing — it assumes one home per process, which is true of the app and
 * false of a test file. Without this the second case reads the first one's accounts.
 */
export function resetForgeStore(): void {
	loaded = null;
}

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
 * The keychain, for reading what an older build wrote and nothing else.
 *
 * Entries stored before this change are sealed by `safeStorage`, and the ones that can still be
 * opened are worth carrying across rather than making somebody sign in again to complete a
 * migration whose entire purpose is to stop making them sign in again. The ones that cannot — the
 * macOS case this change exists for — are dropped, and the account is marked as needing a token.
 *
 * Imported dynamically for the same reason as everything else here that touches Electron: this
 * module is reachable from tests, where `electron` is not a module that exists.
 */
async function legacyKeychain(): Promise<{ decrypt(value: Buffer): string } | null> {
	try {
		const { safeStorage } = await import("electron");
		if (!safeStorage?.isEncryptionAvailable()) return null;
		return { decrypt: (value) => safeStorage.decryptString(value) };
	} catch {
		return null;
	}
}

/*
 * There used to be an `encryptionAvailable` here, and a settings page with two versions of the
 * truth to match: encrypted where the machine had a keyring, plaintext where it did not. The seal
 * no longer asks the OS for anything, so there is one answer and the question is gone with it.
 */

export async function listAccounts(): Promise<ForgeAccount[]> {
	return (await read()).entries.map((entry) => entry.account);
}

export async function accountById(id: string): Promise<ForgeAccount | null> {
	return (await read()).entries.find((entry) => entry.account.id === id)?.account ?? null;
}

/**
 * The secret for one account, opened. Null when there is no such account, or no opening it.
 *
 * Three shapes reach here, because two of them predate this file's current form: a value sealed by
 * the vault, one sealed by the keychain an older build used, and — on a machine that never had a
 * keyring — a token in the clear. The first is the ordinary case; the other two are read once and
 * rewritten as the first.
 */
export async function tokenFor(id: string): Promise<string | null> {
	const entry = (await read()).entries.find((e) => e.account.id === id);
	if (!entry) return null;

	if (isSealed(entry.token)) return unseal(entry.token);

	if (!entry.encrypted) {
		// Plaintext from a build that found no keyring. Seal it now that sealing needs no keyring.
		await reseal(id, entry.token);
		return entry.token;
	}

	const legacy = await legacyKeychain();
	if (!legacy) return null;
	try {
		const token = legacy.decrypt(Buffer.from(entry.token, "base64"));
		await reseal(id, token);
		return token;
	} catch {
		/*
		 * The keychain will not open what it wrote, which on macOS means the app was updated: the
		 * entry is bound to the code identity that created it, and an ad-hoc signed build gets a new
		 * one every release. This is the case the vault exists to end — but it cannot recover a token
		 * already lost to it.
		 *
		 * Null rather than a throw: the caller turns it into "this account needs signing in again",
		 * which is both true and actionable, where a decryption stack trace is neither.
		 */
		return null;
	}
}

/** Rewrite one account's token in the current format, leaving everything else alone. */
async function reseal(id: string, token: string): Promise<void> {
	const file = await read();
	const at = file.entries.findIndex((e) => e.account.id === id);
	if (at < 0) return;
	const entries = [...file.entries];
	entries[at] = { ...entries[at], token: await seal(token), encrypted: true };
	await write({ version: 1, entries });
}

/** Save an account and its token, replacing whatever was filed under the same id. */
export async function saveAccount(account: ForgeAccount, token: string): Promise<void> {
	const file = await read();
	const entry: StoredEntry = { account, token: await seal(token), encrypted: true };

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
