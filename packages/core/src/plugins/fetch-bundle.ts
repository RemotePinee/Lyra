/**
 * Getting a bundle's files onto disk, by whichever route is available.
 *
 * There are two, and the order matters. A registry that builds its entries publishes an archive
 * with a SHA-256; downloading that is one request, it is verifiable, and it keeps working when the
 * upstream repository has been renamed, made private or deleted. A plain index in a git repo
 * publishes no such thing, so cloning stays — it is the only route that works everywhere, and it is
 * also what happens when a download fails.
 *
 * The archive is *verified* rather than trusted. The hash comes from the index over HTTPS and the
 * bytes come from the platform over HTTPS, so an attacker would need both; checking anyway costs
 * one pass over a few hundred kilobytes and turns "probably the right file" into "this file".
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import type { RegistryEntry } from "@lyra/registry-shared";

const run = promisify(execFile);

/** How long a download has before we give up and fall back to git. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** No bundle is this large. The platform refuses to build anything over 20MB. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export interface FetchResult {
	/** Which route actually worked, for the diagnostic the caller shows. */
	via: "tarball" | "git";
	/** Set when the tarball route was tried and failed, so the fallback can be explained. */
	fellBackBecause?: string;
}

/**
 * Put the bundle's files in `staging`, and say how they got there.
 *
 * Throws only when both routes fail. A tarball that cannot be fetched or does not match its hash is
 * not fatal — it becomes a reason recorded on the result, and the clone proceeds.
 */
export async function fetchBundle(entry: RegistryEntry, staging: string): Promise<FetchResult> {
	if (entry.tarball) {
		try {
			await fromTarball(entry, staging);
			return { via: "tarball" };
		} catch (error) {
			/*
			 * Start over before cloning.
			 *
			 * A failed extraction can leave a partial tree, and cloning into a directory that already
			 * has files in it fails with a message about the directory rather than about the download.
			 */
			await rm(staging, { recursive: true, force: true });
			const because = error instanceof Error ? error.message : String(error);
			await fromGit(entry, staging);
			return { via: "git", fellBackBecause: because };
		}
	}

	await fromGit(entry, staging);
	return { via: "git" };
}

async function fromGit(entry: RegistryEntry, staging: string): Promise<void> {
	await run("git", ["clone", "--depth", "1", entry.repository, staging], { timeout: 60_000 });
}

/**
 * Download, verify, unpack.
 *
 * Unpacked with the system `tar` rather than a parser of our own. Every platform this runs on has
 * one — macOS and Linux for decades, Windows since 10 — the main process already shells out to
 * `git` two lines above, and a tar implementation is a surprising amount of code to own for the
 * sake of avoiding a subprocess that is already there.
 */
async function fromTarball(entry: RegistryEntry, staging: string): Promise<void> {
	const url = entry.tarball!;
	if (!/^https:\/\//i.test(url)) throw new Error("下载地址不是 https");

	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		headers: { accept: "application/gzip" },
	});
	if (!response.ok) throw new Error(`下载返回 ${response.status}`);

	const archive = new Uint8Array(await response.arrayBuffer());
	if (archive.length === 0) throw new Error("下载到的是空文件");
	if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("下载的包过大");

	/*
	 * The hash from the index, or the one the platform sent with the bytes.
	 *
	 * Preferring the index's is deliberate: it was fetched separately, so matching it proves the
	 * download agrees with what the catalogue advertised. The header is a fallback for a client that
	 * only has a URL, and is worth strictly less — it arrived with the thing it describes.
	 */
	const expected = entry.sha256 ?? response.headers.get("x-lyra-sha256") ?? undefined;
	if (expected) {
		const actual = createHash("sha256").update(archive).digest("hex");
		if (actual !== expected.toLowerCase()) {
			throw new Error(`校验失败：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`);
		}
	}

	await mkdir(staging, { recursive: true });
	const file = `${staging}.tar.gz`;
	try {
		await writeFile(file, archive);
		/*
		 * `-C staging` so nothing can be written outside it even if the archive says otherwise, and
		 * no `-P`, so tar strips any leading `/` and refuses `..` on every platform's implementation.
		 */
		await run("tar", ["-xzf", file, "-C", staging], { timeout: 60_000 });
	} finally {
		await rm(file, { force: true });
	}
}
