/**
 * Running a command on this machine, inside whatever confinement this machine can provide.
 *
 * Without a mode this is what it always was: the user's own shell, cwd and environment. That is
 * the right default for a tool somebody is sitting in front of, and it is what the CLI and the
 * tests get.
 *
 * With a mode, the command is wrapped — `sandbox-exec` on macOS, `bwrap` on Linux — and if this
 * host cannot provide that, the call **throws**. Not falling back is the entire point. A sandbox
 * that quietly runs the command anyway when it cannot confine it is worse than no sandbox: the UI
 * says confined, the logs say confined, and nothing is.
 */

import { spawn } from "node:child_process";
import { decodeProcessOutput, systemShell } from "../platform.ts";
import type { Sandbox, SandboxProcess } from "../kernel/services.ts";
import { confine } from "./backend.ts";
import type { SandboxMode } from "./policy.ts";

/**
 * Kept out of the child's environment.
 *
 * A pager waiting for a keypress hangs the turn, and colour codes reach the model as noise it has
 * to read past. `TERM=dumb` is what tells most programs both at once.
 */
const QUIET_ENV = {
	TERM: "dumb",
	NO_COLOR: "1",
	GIT_PAGER: "cat",
	PAGER: "cat",
	PYTHONIOENCODING: "utf-8",
	PYTHONUNBUFFERED: "1",
	FORCE_COLOR: "0",
};

export class LocalSandbox implements Sandbox {
	run(command: string, options: { cwd: string; env?: Record<string, string>; mode?: SandboxMode }): SandboxProcess {
		const shell = systemShell();
		const env = { ...process.env, ...QUIET_ENV, ...options.env };

		/*
		 * The wrapper takes the shell as an argument instead of `spawn`'s `shell: true`.
		 *
		 * `shell: true` asks Node to build the argv itself, which leaves no place to put
		 * `sandbox-exec -p <profile> --` in front of it. Naming the shell explicitly is the same
		 * command through one more process, and it is the only arrangement where the confinement
		 * is applied *before* the shell exists rather than around a shell that is already running.
		 */
		const wrap = options.mode ? confine({ mode: options.mode, workspaceRoot: options.cwd }) : null;
		const shellArgs = shell.args ?? [shell.flag];
		const child = wrap
			? spawn(wrap.command, [...wrap.args, shell.file, ...shellArgs, command], {
					cwd: options.cwd,
					// The Windows runner needs `ELECTRON_RUN_AS_NODE`; the others contribute nothing.
					env: { ...env, ...wrap.env },
				})
			: shell.args && shell.args.length > 1
				? spawn(shell.file, [...shellArgs, command], { cwd: options.cwd, env })
				: spawn(command, { cwd: options.cwd, shell: shell.file, env });

		return {
			onOutput(listener) {
				const forward = (chunk: Buffer) => listener(decodeProcessOutput(chunk));
				child.stdout?.on("data", forward);
				child.stderr?.on("data", forward);
			},
			onExit(listener) {
				child.on("close", (code: number | null) => listener(code));
			},
			onError(listener) {
				child.on("error", listener);
			},
			kill() {
				child.kill("SIGKILL");
			},
		};
	}
}
