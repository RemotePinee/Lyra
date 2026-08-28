/**
 * Running git.
 *
 * One place that shells out, so every caller gets the same buffer limit and the same shape of
 * answer: reads return stdout and let a failure throw, writes report success as a value. Git says a
 * great deal on stderr that is not an error, so the exit code is what decides.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAX_FILES = 200;
export const MAX_BLOB_BYTES = 400_000;

/**
 * How many per-file reads may be outstanding at once.
 *
 * Every one of them is a `git show` — a process spawn — or a working-tree read, so this bounds
 * processes as much as descriptors. Unbounded over `MAX_FILES` would put two hundred git processes
 * on the machine at the same instant, trading a slow panel for a stalled laptop; one at a time is
 * what the three callers below all used to do, and it is a full round trip per file with nothing
 * else in flight. Eight keeps the spawn latency and the disk overlapped without being felt
 * elsewhere.
 */
const FILE_CONCURRENCY = 8;

/**
 * `Promise.all` with a ceiling, results in the order they went in.
 *
 * Shared rather than written three times because all three callers — the working-tree diff, the
 * ref-to-ref diff, and counting untracked files for status — have exactly the same shape: a list
 * of paths, one independent read each, and a wait that was almost entirely latency.
 */
export async function mapLimit<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const out = Array.from<R>({ length: items.length });
	let next = 0;
	const workers = Array.from({ length: Math.min(FILE_CONCURRENCY, items.length) }, async () => {
		for (let i = next++; i < items.length; i = next++) out[i] = await run(items[i]);
	});
	await Promise.all(workers);
	return out;
}

export async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

/**
 * The same, without deciding that the answer is text.
 *
 * `git show HEAD:logo.png` answers with a PNG. Decoded as UTF-8 it becomes mojibake that looks
 * enough like text to be diffed, counted and displayed — which is exactly what the review panel
 * used to do with every deleted image. Whether bytes are text is the caller's question, and it
 * cannot ask it once the bytes have already been mangled into a string.
 */
export async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		maxBuffer: 32 * 1024 * 1024,
		encoding: "buffer",
	});
	return stdout;
}

/**
 * Run git for its effect, reporting whether it worked.
 *
 * The message matters here in a way it does not for reads: "not a git repository", "would be
 * overwritten by merge" and "no upstream" are what people actually hit, and a bare "failed" tells
 * them none of it.
 */
export async function run(cwd: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
	try {
		await git(cwd, args);
		return { ok: true };
	} catch (error) {
		const detail = error as { stderr?: string; stdout?: string; message?: string };
		const text = (detail.stderr || detail.stdout || detail.message || "").trim();
		return { ok: false, error: text.split("\n").slice(0, 3).join("\n") || "操作失败" };
	}
}
