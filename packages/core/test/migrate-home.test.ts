/**
 * Carrying the old home over.
 *
 * The rename is a one-way door for someone's data: get this wrong and every session, every
 * setting and the API keys look deleted. So the rules are pinned down — move exactly once, never
 * when it would be ambiguous, and never fail hard.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migratePreviousHome } from "../src/session/migrate-home.ts";

/**
 * The old home is looked up from the real home directory, so these tests drive it through
 * `HOME` — which is also the one thing that makes them safe to run on a machine that has one.
 */
async function sandbox(): Promise<{ home: string; previous: string; restore: () => void }> {
	const root = await mkdtemp(join(tmpdir(), "ly-migrate-"));
	const realHome = process.env.HOME;
	const realLyraHome = process.env.LYRA_HOME;
	process.env.HOME = root;
	delete process.env.LYRA_HOME;
	return {
		home: join(root, ".lyra"),
		previous: join(root, ".deepwise"),
		restore: () => {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			if (realLyraHome !== undefined) process.env.LYRA_HOME = realLyraHome;
		},
	};
}

test("the old home is moved, contents and all", async () => {
	const box = await sandbox();
	try {
		await mkdir(join(box.previous, "sessions", "abc"), { recursive: true });
		await writeFile(join(box.previous, "settings.json"), '{"providers":[]}');
		await writeFile(join(box.previous, "sessions", "abc", "one.jsonl"), '{"seq":1}\n');

		const result = await migratePreviousHome(box.home);

		assert.equal(result.moved, true);
		assert.equal(await readFile(join(box.home, "settings.json"), "utf8"), '{"providers":[]}');
		assert.equal(await readFile(join(box.home, "sessions", "abc", "one.jsonl"), "utf8"), '{"seq":1}\n');
	} finally {
		box.restore();
		await rm(join(box.home, ".."), { recursive: true, force: true });
	}
});

test("nothing happens when there is nothing to move", async () => {
	const box = await sandbox();
	try {
		assert.deepEqual(await migratePreviousHome(box.home), { moved: false });
	} finally {
		box.restore();
	}
});

test("two homes are left alone rather than merged", async () => {
	const box = await sandbox();
	try {
		// Someone has already used the renamed app. Merging two histories is not a decision to
		// make on their behalf at startup.
		await mkdir(box.previous, { recursive: true });
		await writeFile(join(box.previous, "settings.json"), "old");
		await mkdir(box.home, { recursive: true });
		await writeFile(join(box.home, "settings.json"), "new");

		assert.equal((await migratePreviousHome(box.home)).moved, false);
		assert.equal(await readFile(join(box.home, "settings.json"), "utf8"), "new", "the new home is untouched");
		assert.equal(await readFile(join(box.previous, "settings.json"), "utf8"), "old", "and so is the old one");
	} finally {
		box.restore();
		await rm(box.home, { recursive: true, force: true });
	}
});

test("an explicit LYRA_HOME means the caller has already decided", async () => {
	const box = await sandbox();
	try {
		await mkdir(box.previous, { recursive: true });
		process.env.LYRA_HOME = box.home;

		assert.equal((await migratePreviousHome(box.home)).moved, false);
	} finally {
		delete process.env.LYRA_HOME;
		box.restore();
	}
});

test("a migration that cannot happen reports rather than throws", async () => {
	const box = await sandbox();
	try {
		// A file where the old home should be: not a directory, so there is nothing to move.
		await writeFile(box.previous, "not a directory");
		const result = await migratePreviousHome(box.home);
		assert.equal(result.moved, false);
		assert.equal(result.error, undefined, "not an error either — there was simply nothing to do");
	} finally {
		box.restore();
	}
});
