/**
 * Creating conversations at the same moment.
 *
 * The index is written whole, through a temporary file and a rename, so a crash cannot leave a
 * truncated one. That temporary name used to be `index.json.<pid>.tmp` — one name per process, for
 * an operation that runs concurrently *within* a process. Two creations racing meant the first
 * rename took the file out from under the second, which failed with `ENOENT` and left its session
 * missing from the index: a conversation that exists on disk and is in no list.
 *
 * Found in the app rather than here, which is why it is here now.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";

test("conversations created at the same moment all reach the index", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-index-race-"));
	try {
		const store = new SessionStore(join(root, "sessions"));
		const made = await Promise.all(Array.from({ length: 8 }, (_, i) => store.create(root, `m${i}`)));

		const listed = await store.listSessions();
		assert.equal(listed.length, 8, "every session is listed");
		for (const meta of made) {
			assert.ok(listed.some((each) => each.id === meta.id), `${meta.id} is missing from the index`);
		}

		// And what it left behind is a whole file, not a half-written one.
		const raw = await readFile(join(root, "sessions", "index.json"), "utf8");
		assert.equal((JSON.parse(raw) as unknown[]).length, 8);
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("no temporary files are left behind", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-index-race-"));
	try {
		const store = new SessionStore(join(root, "sessions"));
		await Promise.all(Array.from({ length: 4 }, (_, i) => store.create(root, `m${i}`)));
		const { readdir } = await import("node:fs/promises");
		const files = await readdir(join(root, "sessions"));
		assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "a rename that happened leaves nothing");
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
