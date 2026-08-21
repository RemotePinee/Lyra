/**
 * Checking an archive before unpacking it, which is the half of installing that has to be right.
 *
 * The download itself is not exercised here — `fromTarball` insists on https, and standing up a
 * server with a certificate this process would accept is a lot of machinery for the least
 * interesting part. What matters is what happens to the bytes once they arrive: a hash that does
 * not match must stop the install rather than produce a plugin, and an archive that names paths
 * outside its own directory must not be able to write there.
 *
 * Both of those are security properties, and a security property nothing checks is a comment. The
 * second one is not even our code — it is a promise about how `tar` behaves without `-P` — which is
 * exactly the kind of thing worth pinning down, because it is invisible in review and true on
 * whichever platform the person reviewing happened to be using.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { unpackVerified } from "../src/plugins/fetch-bundle.ts";

const run = promisify(execFile);

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "lyra-archive-"));
	try {
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** A real gzipped tar of the given files, built by the same `tar` that will unpack it. */
async function archiveOf(files: Record<string, string>): Promise<Uint8Array> {
	const staging = await mkdtemp(join(tmpdir(), "lyra-pack-"));
	try {
		for (const [path, content] of Object.entries(files)) {
			const full = join(staging, path);
			await mkdir(join(full, ".."), { recursive: true });
			await writeFile(full, content);
		}
		const tarball = join(staging, "..", `${staging.split("/").pop()}.tar.gz`);
		await run("tar", ["-czf", tarball, "-C", staging, "."]);
		const bytes = await readFile(tarball);
		await rm(tarball, { force: true });
		return new Uint8Array(bytes);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

test("an archive matching its hash is unpacked", async () => {
	await withDir(async (dir) => {
		const archive = await archiveOf({ "lyra-plugin.json": '{"name":"demo"}' });
		const staging = join(dir, "staging");

		await unpackVerified(archive, sha256(archive), staging);

		assert.equal(await readFile(join(staging, "lyra-plugin.json"), "utf8"), '{"name":"demo"}');
	});
});

test("an archive that does not match its hash is refused, and nothing is unpacked", async () => {
	await withDir(async (dir) => {
		/*
		 * The case this exists for is not a corrupted download — it is bytes that are fine and are not
		 * the ones the catalogue advertised. The index came over one HTTPS connection and the archive
		 * over another; matching them is what makes tampering with either one insufficient.
		 */
		const archive = await archiveOf({ "lyra-plugin.json": '{"name":"not-what-was-advertised"}' });
		const staging = join(dir, "staging");

		await assert.rejects(() => unpackVerified(archive, "a".repeat(64), staging), /校验失败/);

		assert.deepEqual(await readdir(staging).catch(() => []), [], "refused before a single file was written");
	});
});

test("the hash is compared case-insensitively, because an index may shout it", async () => {
	await withDir(async (dir) => {
		const archive = await archiveOf({ "readme.md": "hello" });

		await unpackVerified(archive, sha256(archive).toUpperCase(), join(dir, "staging"));

		assert.equal(await readFile(join(dir, "staging", "readme.md"), "utf8"), "hello");
	});
});

test("an index with no hash still installs, because most of them have none", async () => {
	await withDir(async (dir) => {
		/*
		 * A registry is allowed to be a JSON file in somebody's GitHub repository, and one of those
		 * has nothing to hash — there is no build step to hash the output of. Requiring a hash would
		 * rule out the format the whole thing started as.
		 */
		const archive = await archiveOf({ "readme.md": "hello" });

		await unpackVerified(archive, undefined, join(dir, "staging"));

		assert.equal(await readFile(join(dir, "staging", "readme.md"), "utf8"), "hello");
	});
});

test("an empty download is a failure, not an empty plugin", async () => {
	await withDir(async (dir) => {
		await assert.rejects(() => unpackVerified(new Uint8Array(0), undefined, join(dir, "staging")), /空文件/);
	});
});

test("an archive cannot write outside the directory it is unpacked into", async () => {
	await withDir(async (dir) => {
		/*
		 * `-C staging` and no `-P`: tar strips a leading `/` and refuses `..`, on every implementation
		 * this runs against. That is the guarantee the installer leans on instead of parsing the
		 * archive itself, so it is worth having a test that would notice if it stopped being true.
		 *
		 * Built with `-P` so the malicious paths survive being packed — without it, `tar` refuses to
		 * write them in the first place and the test would pass for the wrong reason.
		 */
		const outside = join(dir, "outside");
		await mkdir(outside, { recursive: true });
		const source = join(dir, "src");
		await mkdir(source, { recursive: true });
		await writeFile(join(source, "escape.txt"), "should never land outside");

		const tarball = join(dir, "evil.tar.gz");
		await run("tar", ["-czPf", tarball, "-C", source, "--transform", "s|escape.txt|../outside/escape.txt|", "escape.txt"])
			// BSD tar has no `--transform`; on macOS the equivalent is `-s`. Either produces an archive
			// naming a path above its own root, which is the only thing this test needs.
			.catch(() => run("tar", ["-czPf", tarball, "-C", source, "-s", "|escape.txt|../outside/escape.txt|", "escape.txt"]));

		/*
		 * That the archive really is malicious, before trusting what happens to it.
		 *
		 * Both spellings above are refused by the other implementation, so on any given machine one of
		 * them fails and the fallback runs. If some third `tar` ever refused both, the archive would
		 * hold a plain `escape.txt`, nothing would escape, and this test would go green while checking
		 * nothing at all — the most expensive kind of passing test.
		 */
		const listed = await run("tar", ["-tzf", tarball]);
		assert.match(listed.stdout, /\.\.\/outside\/escape\.txt/, "the archive must actually name a path above its root");

		const staging = join(dir, "staging");
		// Whether tar refuses loudly or strips the `..` and unpacks it harmlessly is its business;
		// both are correct. What must not happen is a file appearing in `outside`.
		await unpackVerified(new Uint8Array(await readFile(tarball)), undefined, staging).catch(() => {});

		assert.deepEqual(await readdir(outside), [], "nothing escaped into the sibling directory");
	});
});
