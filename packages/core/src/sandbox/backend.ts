/**
 * Which confinement this machine can actually provide, decided by trying it.
 *
 * Selection is by platform first: macOS has Seatbelt, Linux has `bwrap`, and Windows has neither
 * of them. Then the candidate is *probed* — really spawned, with the real profile, around a command
 * that does nothing — because the question is not "is the binary there" but "does the kernel accept
 * what we are about to ask it". `sandbox-exec` exists on every macOS and can still refuse a profile;
 * `bwrap` is often installed without the user namespaces it needs.
 *
 * And when the answer is no, it is no. A backend that cannot confine reports that it cannot, and
 * the caller's choice is to run unconfined *knowingly* or not to run. The one thing that must never
 * happen is the quiet fallback: returning the original argv from a function whose whole purpose was
 * to wrap it, so a command runs with full access under a UI that says it is sandboxed.
 */

import { spawnSync } from "node:child_process";
import { bwrapArgs, canonicalPath, seatbeltArgs, type SandboxEnforcement, type SandboxPolicy } from "./policy.ts";
import { workspaceWriteSid } from "./windows/identity.ts";

/** Where the platform's confinement comes from, or `none` when it has none we can use. */
export type Runner = "seatbelt" | "bwrap" | "windows-acl" | "none";

export interface Confinement {
	/** The command to spawn instead of the original. */
	command: string;
	/** Arguments that go before the wrapped command. */
	args: string[];
	runner: Exclude<Runner, "none">;
	enforcement: SandboxEnforcement;
	/** Extra environment the wrapper needs. Only the Windows runner has any. */
	env?: Record<string, string>;
}

/**
 * The flag that turns this executable into the Windows sandbox runner.
 *
 * Checked before anything else at startup, so a process spawned with it never becomes an app.
 */
export const WINDOWS_RUNNER_FLAG = "--lyra-sandbox-runner";

/**
 * How long a probe may take before it counts as a failure.
 *
 * A probe runs `true` inside the sandbox, so it is milliseconds when it works. This bound is for
 * the case where it does not — a runner that hangs waiting on something must not hang the app's
 * first command. Note that `spawnSync` treats `timeout: 0` as *no timeout*, which is why this is a
 * constant and not a caller-supplied number that could arrive as zero.
 */
const PROBE_TIMEOUT_MS = 5_000;

/** Seams for the tests: they must be able to have a platform, and a verdict, that this host lacks. */
export interface BackendHooks {
	platform?: NodeJS.Platform;
	probe?: (runner: Exclude<Runner, "none">) => boolean;
	/** The `sandbox-exec` to invoke, so a test can point at a script that says no. */
	seatbeltExec?: string;
}

/** Which runners each platform could use, in preference order. */
const PLATFORM_RUNNERS: Partial<Record<NodeJS.Platform, readonly Exclude<Runner, "none">[]>> = {
	darwin: ["seatbelt"],
	linux: ["bwrap"],
	win32: ["windows-acl"],
};

/**
 * What a runner promises when it is selected.
 *
 * Both of ours govern every file effect the mode names, by construction of their profiles — so
 * `full`. This is a table rather than a constant because the honest answer for a third backend
 * (Windows ACL, say) is `partial`, and a caller that needs the absolute boundary has to be able to
 * tell the difference.
 */
const ENFORCEMENT: Record<Exclude<Runner, "none">, SandboxEnforcement> = {
	seatbelt: "full",
	bwrap: "full",
	/*
	 * Partial, and the reasons are structural rather than unfinished work.
	 *
	 * `WRITE_RESTRICTED` needs Everyone in its restricting list or the process dies during loader
	 * initialisation — so any object whose DACL grants Everyone write access stays writable. And
	 * NTFS hard links can alias a file inside the granted tree to a path outside it. Both are
	 * documented boundaries of the mechanism, not gaps that a better implementation closes, and a
	 * caller that needs the absolute promise has to be able to tell this apart from `full`.
	 */
	"windows-acl": "partial",
};

/**
 * Really run something trivial under the real profile.
 *
 * `read-only` with `/` as the workspace is the strictest profile the runner will ever be handed, so
 * a runner that accepts it accepts the rest. `true` is the command because it exists everywhere,
 * writes nothing, and its exit code is unambiguous.
 */
function probeRunner(runner: Exclude<Runner, "none">, seatbeltExec: string): boolean {
	const policy: SandboxPolicy = { mode: "read-only", workspaceRoot: process.platform === "win32" ? process.cwd() : "/" };
	if (runner === "windows-acl") {
		try {
			const wrap = windowsRunnerArgv(policy);
			const probe = spawnSync(wrap.command, [...wrap.args, "cmd.exe", "/c", "exit 0"], {
				timeout: PROBE_TIMEOUT_MS,
				stdio: "ignore",
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			});
			// The runner exits 127 with its own prefix when it cannot confine; anything but a clean
			// zero means this host cannot be trusted to enforce, so it is not offered.
			return probe.status === 0;
		} catch {
			return false;
		}
	}
	try {
		const probe =
			runner === "seatbelt"
				? spawnSync(seatbeltExec, [...seatbeltArgs(policy), "--", "true"], {
						timeout: PROBE_TIMEOUT_MS,
						stdio: "ignore",
					})
				: spawnSync("bwrap", [...bwrapArgs(policy), "--", "true"], {
						timeout: PROBE_TIMEOUT_MS,
						stdio: "ignore",
					});
		return probe.status === 0;
	} catch {
		// Spawning the runner itself failed — it is not there, or not executable.
		return false;
	}
}

/**
 * The probe result for this process.
 *
 * Cached because probing spawns a process, and the answer cannot change while the app is running:
 * `sandbox-exec` does not appear halfway through a session. Keyed by runner so a test that injects
 * one platform does not poison another's entry.
 */
const probed = new Map<string, boolean>();

/** Forget the cached probes. For tests, which need to probe again with different hooks. */
export function resetProbeCache(): void {
	probed.clear();
}

/**
 * The runner this host can use, or `none`.
 *
 * `none` is a legitimate answer — an unsupported platform, a stripped-down container, a macOS with
 * a broken `sandbox-exec`. What the caller does about it is the caller's decision; what this
 * function must not do is pretend.
 */
export function selectRunner(hooks: BackendHooks = {}): Runner {
	const platform = hooks.platform ?? process.platform;
	const seatbeltExec = hooks.seatbeltExec ?? "/usr/bin/sandbox-exec";
	for (const runner of PLATFORM_RUNNERS[platform] ?? []) {
		const key = `${platform}:${runner}:${seatbeltExec}`;
		let ok = probed.get(key);
		if (ok === undefined) {
			ok = hooks.probe ? hooks.probe(runner) : probeRunner(runner, seatbeltExec);
			probed.set(key, ok);
		}
		if (ok) return runner;
	}
	return "none";
}

/**
 * How to spawn one command under a policy — or `null` when the policy asks for no confinement.
 *
 * Throws when confinement is asked for and cannot be provided. That is the fail-closed direction,
 * and it is the whole point: a caller that wants to run anyway can catch this and choose to, in
 * which case running unconfined was a decision somebody made rather than something that happened.
 */
export function confine(policy: SandboxPolicy, hooks: BackendHooks = {}): Confinement | null {
	if (policy.mode === "danger-full-access") return null;

	const runner = selectRunner(hooks);
	if (runner === "none") {
		const platform = hooks.platform ?? process.platform;
		throw new SandboxUnavailableError(
			`这台机器上没有可用的沙箱后端（平台 ${platform}），无法以「${policy.mode}」模式运行。`,
		);
	}

	if (runner === "seatbelt") {
		return {
			command: hooks.seatbeltExec ?? "/usr/bin/sandbox-exec",
			args: [...seatbeltArgs(policy), "--"],
			runner,
			enforcement: ENFORCEMENT[runner],
		};
	}
	if (runner === "windows-acl") {
		const wrap = windowsRunnerArgv(policy);
		return { command: wrap.command, args: wrap.args, runner, enforcement: ENFORCEMENT[runner], env: wrap.env };
	}
	return { command: "bwrap", args: [...bwrapArgs(policy), "--"], runner, enforcement: ENFORCEMENT[runner] };
}

/**
 * The argv that runs one command through the Windows runner.
 *
 * Spawns *this executable* rather than a separate script. Under Electron there is no standalone
 * `node` to reach for, and shipping one would be a second runtime to keep in step; `execPath` with
 * `ELECTRON_RUN_AS_NODE` is the supported way to get a Node process out of the one already here.
 * The marker flag is what the entry point checks before doing anything else.
 */
function windowsRunnerArgv(policy: SandboxPolicy): { command: string; args: string[]; env: Record<string, string> } {
	const workspace = canonicalPath(policy.workspaceRoot);
	const args = [WINDOWS_RUNNER_FLAG, "--workspace", workspace, "--mode", policy.mode];
	if (policy.mode === "workspace-write") args.push("--write-sid", workspaceWriteSid(workspace));
	args.push("--");
	return { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** Confinement was required and this host cannot provide it. Distinct so a caller can catch it. */
export class SandboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUnavailableError";
	}
}

/**
 * Whether the sandbox stopped this command, read out of what it printed.
 *
 * The exit code cannot answer this. A command denied a write fails the way it fails when a disk is
 * full or a path is wrong — some non-zero number that means "it did not work", with no way to tell
 * a policy decision from a bug in the command. The runners do say so on stderr, and that line is
 * the only signal there is.
 *
 * Being wrong here is cheap in one direction and not the other: a missed denial reads as an
 * ordinary failure (the model retries, gets nowhere, and says so), while a false positive would
 * offer an escalation prompt for something the sandbox never blocked. So the patterns are the ones
 * the runners actually emit, not a general net for the words "denied" or "permission".
 */
export function looksDenied(output: string): boolean {
	return DENIAL_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * Case-insensitive, because the shell writes this line and shells disagree.
 *
 * `bash` reports EPERM as `Operation not permitted`; `zsh` — which is the default shell on macOS,
 * and therefore what most of these commands actually run under — writes `operation not permitted`,
 * lower case, in a differently shaped line. The unit tests used bash's wording and passed; the
 * first end-to-end run under a real user's shell is what showed the other half existed.
 */
const DENIAL_PATTERNS = [
	/\boperation not permitted\b/i,
	/\bsandbox-exec:/i,
	/\bdeny file-write\b/i,
	/\bbwrap:.*(?:permission denied|read-only file system)/i,
	/\bread-only file system\b/i,
];
