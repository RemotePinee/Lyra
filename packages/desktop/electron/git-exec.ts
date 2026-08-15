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

export async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
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
