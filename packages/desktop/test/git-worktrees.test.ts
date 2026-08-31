/**
 * Tests for Git worktree management, creation, auto-creation and cleanup.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import {
	autoCreateSessionWorktree,
	cleanOldWorktrees,
	createWorktree,
	pruneWorktrees,
	removeWorktree,
	resolveWorktreesRoot,
} from "../electron/git-worktrees.ts";
import { listWorktrees } from "../electron/git-repos.ts";
import { DEFAULT_SETTINGS } from "@lyra/core";

const exec = promisify(execFile);

let dir: string;
let origin: string;
let root: string;

async function git(args: string[], cwd = dir): Promise<string> {
	const { stdout } = await exec("git", args, { cwd });
	return stdout;
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "lyra-wt-test-"));
	dir = join(root, "work");
	origin = join(root, "origin.git");

	await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
	await exec("git", ["init", "--initial-branch=main", dir]);
	await git(["config", "user.email", "test@example.com"]);
	await git(["config", "user.name", "Test"]);
	await writeFile(join(dir, "README.md"), "# Test\n");
	await git(["add", "."]);
	await git(["commit", "-m", "initial commit"]);
	await git(["remote", "add", "origin", origin]);
	await git(["push", "-u", "origin", "main"]);
});

after(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

test("resolveWorktreesRoot handles default and custom paths", () => {
	const defaultPath = resolveWorktreesRoot();
	assert.ok(defaultPath.length > 0);
	assert.ok(defaultPath.includes("worktrees"));

	const custom = resolveWorktreesRoot("~/my-custom-worktrees");
	assert.ok(!custom.startsWith("~"));
	assert.ok(custom.includes("my-custom-worktrees"));
});

test("createWorktree creates a linked worktree and listWorktrees lists it", async () => {
	const res = await createWorktree(dir, "feature/wt-1");
	assert.equal(res.ok, true);
	assert.ok(res.path && existsSync(res.path));
	assert.equal(res.branch, "feature/wt-1");

	const trees = await listWorktrees(dir);
	assert.ok(trees.length >= 2);
	const linked = trees.find((t) => t.path === res.path);
	assert.ok(linked);
	assert.equal(linked.worktree, true);
	assert.equal(linked.branch, "feature/wt-1");
});

test("removeWorktree removes a linked worktree and cleans it up", async () => {
	const created = await createWorktree(dir, "feature/wt-to-remove");
	assert.equal(created.ok, true);
	assert.ok(created.path && existsSync(created.path));

	const removed = await removeWorktree(dir, created.path);
	assert.equal(removed.ok, true);
	assert.equal(existsSync(created.path), false);

	const trees = await listWorktrees(dir);
	assert.ok(!trees.some((t) => t.path === created.path));
});

test("autoCreateSessionWorktree creates dedicated worktree when enabled in settings", async () => {
	const customSettings = {
		...DEFAULT_SETTINGS,
		worktrees: {
			autoCreateOnNewSession: true,
			rootDir: join(root, "session-worktrees"),
		},
	};

	const res = await autoCreateSessionWorktree(dir, customSettings, "session-12345678");
	assert.equal(res.worktreeCreated, true);
	assert.ok(res.cwd.includes("session-worktrees"));
	assert.ok(existsSync(res.cwd));

	// Test disabled setting
	const disabledSettings = {
		...DEFAULT_SETTINGS,
		worktrees: {
			autoCreateOnNewSession: false,
		},
	};
	const resDisabled = await autoCreateSessionWorktree(dir, disabledSettings, "session-999");
	assert.equal(resDisabled.worktreeCreated, false);
	assert.equal(resDisabled.cwd, dir);
});

test("cleanOldWorktrees prunes excess worktrees above keepLimit while protecting active ones", async () => {
	// Create multiple worktrees
	const wt1 = await createWorktree(dir, "cleanup/wt-1");
	const wt2 = await createWorktree(dir, "cleanup/wt-2");
	const wt3 = await createWorktree(dir, "cleanup/wt-3");

	assert.ok(wt1.path && wt2.path && wt3.path);

	const cleanSettings = {
		...DEFAULT_SETTINGS,
		worktrees: {
			autoCleanOld: true,
			keepLimit: 2,
		},
	};

	// wt1 is active, should not be deleted
	const active = new Set([wt1.path]);
	const cleanedCount = await cleanOldWorktrees(dir, cleanSettings, active);
	assert.ok(cleanedCount >= 1);
	assert.equal(existsSync(wt1.path), true, "active session worktree must be preserved");

	await pruneWorktrees(dir);
});

/**
 * The guard has to hold whatever the path looks like.
 *
 * On Windows it did not, and the failure was silent and destructive: `git worktree list` prints
 * `C:/Users/...` while everything else in the app produces `C:\Users\...`, so the set of active
 * worktrees never matched and the cleanup deleted the checkout the session was running in. The
 * spelling below is the one git would have produced; the assertion is that it is still recognised.
 */
test("a worktree in use is protected however its path is spelled", async () => {
	const keep = await createWorktree(dir, "spelling/in-use");
	const doomed = await createWorktree(dir, "spelling/idle-1");
	const alsoDoomed = await createWorktree(dir, "spelling/idle-2");
	assert.ok(keep.path && doomed.path && alsoDoomed.path);

	const settings = { ...DEFAULT_SETTINGS, worktrees: { autoCleanOld: true, keepLimit: 1 } };

	/*
	 * Built by hand, not with `join`.
	 *
	 * `join` normalises the `..` away, which would make this string identical to `keep.path` and
	 * the test vacuous — it passed before the fix on macOS for exactly that reason. Written out, it
	 * is a different string naming the same directory, which is the whole situation being tested.
	 */
	const awkward = `${keep.path}/../${basename(keep.path)}`;
	assert.notEqual(awkward, keep.path, "the awkward spelling must actually differ, or this proves nothing");

	const cleaned = await cleanOldWorktrees(dir, settings, new Set([awkward]));

	assert.ok(cleaned >= 1, "the idle worktrees should still be cleaned");
	assert.equal(existsSync(keep.path), true, "the worktree in use must survive an odd spelling");

	await pruneWorktrees(dir);
});
