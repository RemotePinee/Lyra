/**
 * Running git.
 *
 * One place that shells out, so every caller gets the same buffer limit and the same shape of
 * answer: reads return stdout and let a failure throw, writes report success as a value. Git says a
 * great deal on stderr that is not an error, so the exit code is what decides.
 */

import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The variables that tell git to work somewhere other than `cwd`.
 *
 * Every one of these outranks the directory a process is started in. `GIT_DIR=…` alone is enough
 * to make `git rev-parse --is-inside-work-tree` answer about a completely different repository, or
 * refuse to answer at all — and the answer the window drew from that was 「不是 Git 仓库」 about a
 * project with a perfectly good `.git` in it.
 *
 * They arrive by inheritance. Anything that starts Lyra from inside a git operation passes them
 * down: a `git` hook, `git rebase --exec`, a terminal still holding them from an earlier command.
 * The app never sets them and never wants them, so they are dropped rather than trusted — the
 * directory is the whole of what these calls mean to ask about.
 */
const REDIRECTING = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_PREFIX",
];

/**
 * Where git is likely to be, for a process that was not started from a shell.
 *
 * A GUI-launched app on macOS inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — none of
 * the login shell's additions. `git` from Homebrew or MacPorts is then simply not on the path, and
 * the spawn fails with ENOENT, which reads exactly like a directory that is not a repository.
 * Appended rather than prepended, so a path the user did set still wins.
 */
const LIKELY_PATHS = ["/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", "/usr/bin", "/bin"];

/** The environment git should run in, given the one this process was handed. */
export function gitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const name of REDIRECTING) delete env[name];

	const path = env.PATH ?? "";
	const known = new Set(path.split(delimiter).filter(Boolean));
	const missing = LIKELY_PATHS.filter((dir) => !known.has(dir));
	if (missing.length > 0) env.PATH = [path, ...missing].filter(Boolean).join(delimiter);

	return env;
}

/**
 * Built once. `process.env` does not change under us, and rebuilding it per call would put this
 * work on the path of every `git show` in a two-hundred-file diff.
 */
const GIT_ENV = gitEnvironment(process.env);

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
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: GIT_ENV });
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
		env: GIT_ENV,
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
