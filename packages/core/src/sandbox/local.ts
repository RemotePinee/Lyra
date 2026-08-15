/**
 * Running a command on this machine.
 *
 * The default sandbox, and the one that isn't one: the command gets the user's own shell, cwd and
 * environment. That is the right default for a tool the user is sitting in front of, and the wrong
 * one for anything else — which is why it goes through the seam rather than being called directly.
 */

import { spawn } from "node:child_process";
import type { Sandbox, SandboxProcess } from "../kernel/services.ts";

/**
 * Kept out of the child's environment.
 *
 * A pager waiting for a keypress hangs the turn, and colour codes reach the model as noise it has
 * to read past. `TERM=dumb` is what tells most programs both at once.
 */
const QUIET_ENV = { TERM: "dumb", NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" };

export class LocalSandbox implements Sandbox {
	run(command: string, options: { cwd: string; env?: Record<string, string> }): SandboxProcess {
		const child = spawn(command, {
			cwd: options.cwd,
			shell: process.env.SHELL || "/bin/bash",
			env: { ...process.env, ...QUIET_ENV, ...options.env },
		});

		return {
			onOutput(listener) {
				const forward = (chunk: Buffer) => listener(chunk.toString("utf8"));
				child.stdout?.on("data", forward);
				child.stderr?.on("data", forward);
			},
			onExit(listener) {
				child.on("close", (code) => listener(code));
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
