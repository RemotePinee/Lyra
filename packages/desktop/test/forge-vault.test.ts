/**
 * Forge tokens surviving an update, which is the whole point of moving them off the keychain.
 *
 * The failure being fixed: macOS builds are ad-hoc signed, so each release has a different code
 * identity, and a keychain entry is bound to the identity that wrote it. Signing in to GitHub was
 * therefore something you did after every update. See `config/vault.ts` in core.
 *
 * Three shapes can be on disk, and all three have to be handled without asking anyone to sign in
 * again to complete a migration whose purpose is to stop asking:
 *
 *   - sealed by the vault — the ordinary case now
 *   - plaintext — what a machine with no keyring got from the old code
 *   - sealed by the keychain — every macOS install written before this change
 *
 * The first two are covered here. The third needs Electron's `safeStorage`, which does not exist
 * in this process — `legacyKeychain()` returns null, and the token reads as needing a fresh
 * sign-in, which is exactly what it does on a machine whose keychain has stopped answering.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import { isSealed, resetVault, seal } from "@lyra/core";

import { saveAccount, tokenFor } from "../electron/forge/vault.ts";
import type { ForgeAccount } from "../electron/forge/types.ts";

let home: string;
const made: string[] = [];
const previous = { home: process.env.LYRA_HOME, userProfile: process.env.USERPROFILE };

/**
 * A whole account, because the store validates what it reads.
 *
 * `parseAccounts` drops an entry it cannot make sense of, and drops the token with it — so a
 * half-built fixture reads back as "no such account" and looks exactly like the bug these tests
 * are about. `baseUrl` and `kind` are the two it will not do without.
 */
const account: ForgeAccount = {
	id: "acc-1",
	kind: "github",
	label: "someone · github.com",
	baseUrl: "https://github.com",
	login: "someone",
	avatarUrl: null,
	addedAt: 1,
	enabled: true,
};

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "lyra-forge-"));
	made.push(home);
	process.env.LYRA_HOME = home;
	process.env.USERPROFILE = home;
	resetVault();
	// The forge store caches the file it read; the next test's is a different file entirely.
	const module = await import("../electron/forge/vault.ts");
	module.resetForgeStore();
});

after(async () => {
	if (previous.home === undefined) delete process.env.LYRA_HOME;
	else process.env.LYRA_HOME = previous.home;
	if (previous.userProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previous.userProfile;
	await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The stored file, as a test that wants to inspect the format reads it. */
async function stored(): Promise<{ entries: { account: ForgeAccount; token: string; encrypted: boolean }[] }> {
	return JSON.parse(await readFile(join(home, "forges.json"), "utf8"));
}

test("a saved token comes back, and is not written down in the clear", async () => {
	await saveAccount(account, "ghp_not_a_real_token");

	const file = await stored();
	assert.equal(file.entries.length, 1);
	assert.ok(isSealed(file.entries[0].token), "the token was not sealed");
	assert.ok(!file.entries[0].token.includes("ghp_not_a_real_token"), "the plaintext is in the file");

	assert.equal(await tokenFor("acc-1"), "ghp_not_a_real_token");
});

test("the file stays 0600", async () => {
	await saveAccount(account, "ghp_not_a_real_token");
	const mode = (await stat(join(home, "forges.json"))).mode & 0o777;
	assert.equal(mode, 0o600, `forges.json is ${mode.toString(8)}`);
});

test("a plaintext token from a machine with no keyring is read, then sealed in place", async () => {
	// What the old code wrote when `safeStorage` reported no encryption available.
	await writeFile(
		join(home, "forges.json"),
		JSON.stringify({ version: 1, entries: [{ account, token: "ghp_written_in_the_clear", encrypted: false }] }),
		"utf8",
	);

	// Read once: the value has to survive, or the migration costs someone their sign-in.
	assert.equal(await tokenFor("acc-1"), "ghp_written_in_the_clear");

	// And it is no longer in the clear afterwards, without anyone having saved anything.
	const file = await stored();
	assert.ok(isSealed(file.entries[0].token), "the plaintext token was left as it was found");
	assert.equal(await tokenFor("acc-1"), "ghp_written_in_the_clear", "and it still reads back");
});

test("a token this key cannot open reads as needing a fresh sign-in, not as a crash", async () => {
	// Stands in for a keychain-sealed entry after an update: present, well-formed, unopenable.
	await writeFile(
		join(home, "forges.json"),
		JSON.stringify({ version: 1, entries: [{ account, token: "bm90IG1pbmUgdG8gb3Blbg==", encrypted: true }] }),
		"utf8",
	);

	assert.equal(await tokenFor("acc-1"), null);
});

test("a sealed token written under a different key is null rather than wrong", async () => {
	const sealed = await seal("ghp_sealed_elsewhere");
	await writeFile(
		join(home, "forges.json"),
		JSON.stringify({ version: 1, entries: [{ account, token: sealed, encrypted: true }] }),
		"utf8",
	);

	// A new key file, as if the profile had been restored without it.
	await rm(join(home, "vault.key"), { force: true });
	resetVault();
	const module = await import("../electron/forge/vault.ts");
	module.resetForgeStore();

	assert.equal(await tokenFor("acc-1"), null);
});
