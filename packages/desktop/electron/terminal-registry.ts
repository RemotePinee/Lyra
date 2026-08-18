/**
 * The embedded terminal.
 *
 * A pty per project directory, and — the part worth reading — one that outlives the pane showing
 * it. The pane comes and goes constantly: closing it, switching to a conversation whose layout
 * does not include it, or making another pane full screen all unmount it. Tying the shell's life
 * to the pane meant every one of those killed it, so coming back gave you a new shell in the same
 * place: no history, no running process, no half-typed command. That reads as the terminal
 * restarting itself, and next to a real terminal emulator — where a window you are not looking at
 * keeps running — it reads as broken.
 *
 * So the renderer attaches and detaches, and only `kill` ends anything. Detaching keeps the shell
 * running and keeps recording what it writes, and the next attach replays that recording into the
 * fresh xterm, which redraws to exactly what was on screen before.
 *
 * The window is reached through a getter rather than held: it is replaced when the app is reopened
 * from the dock, and a captured reference would go on writing to a window nobody can see.
 *
 * No Electron values are imported here, only types — so this can be driven straight from a test,
 * which is where every claim above is checked.
 */

import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";

/**
 * One shell, and enough of what it has said to redraw it.
 *
 * `attached` is whether a pane is currently listening. A detached shell keeps running and keeps
 * filling `scrollback`; it simply stops being forwarded to a renderer that has nothing to do with
 * it yet.
 */
export interface LiveTerminal {
	pty: IPty;
	cwd: string;
	attached: boolean;
	/** Raw output, in the chunks it arrived in, capped by `SCROLLBACK_BYTES`. */
	scrollback: string[];
	bytes: number;
	/** When a pane last attached, so the least useful shell is the one retired. */
	touched: number;
}

export interface TerminalDeps {
	terminals: Map<string, LiveTerminal>;
	spawnPty: (file: string, args: string[], options: Record<string, unknown>) => IPty;
	insideAProject(target: string): boolean;
	window(): BrowserWindow | null;
}

/**
 * How much output is kept for redrawing a pane that comes back.
 *
 * Enough for a screen of a long build's output several times over, and small enough that a shell
 * left running `yes` overnight cannot grow the main process without bound. Whole chunks are
 * dropped rather than bytes, because half an escape sequence replays as garbage.
 */
const SCROLLBACK_BYTES = 256 * 1024;

/**
 * How many shells may be kept alive at once.
 *
 * These survive their panes, so without a ceiling a week of moving between projects would leave a
 * dozen idle shells running. Four covers going back and forth between the projects anyone has
 * open at once; past that the one nobody has returned to for longest is the one to end.
 */
const MAX_TERMINALS = 4;

/**
 * The behaviour, with no Electron in it.
 *
 * Separated from the IPC handlers in `ipc/terminal.ts` so it can be driven directly: which shell an attach lands
 * on, what a detach leaves running and which one gets retired are the whole point of this file,
 * and they are decided here rather than in a message handler.
 */
export function createTerminalRegistry({ terminals, spawnPty, insideAProject, window }: TerminalDeps) {
	/**
	 * Connect a pane to a shell for this directory, starting one only if there is not one already.
	 *
	 * Returns what the pane needs to redraw itself: the id to address it by, and everything the
	 * shell has written. `pid` is returned as well — it is what makes "the same shell" checkable
	 * from a test, rather than inferred from output that looks similar.
	 */
	const attach = (cwd: string, cols: number, rows: number): { id: string; pid: number; replay: string } => {
		const home = process.env.HOME || process.cwd();
		const dir = insideAProject(cwd) ? cwd : home;

		const existing = [...terminals].find(([, live]) => live.cwd === dir);
		if (existing) {
			const [id, live] = existing;
			live.attached = true;
			live.touched = Date.now();
			/*
			 * The pane it left is not the pane it came back to: the dock may have resized in
			 * between, and a shell told nothing wraps every line to a width that is no longer
			 * there. A caller that does not know the size yet passes nothing and is not allowed to
			 * shrink the shell to a sliver on its way to finding out.
			 */
			if (cols > 0 && rows > 0) {
				try {
					live.pty.resize(Math.max(2, cols), Math.max(2, rows));
				} catch {}
			}
			return { id, pid: live.pty.pid, replay: live.scrollback.join("") };
		}

		retireIdle(terminals);

		const id = randomUUID();
		const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
		const child = spawnPty(shell, [], {
			name: "xterm-256color",
			cols: Math.max(2, cols),
			rows: Math.max(2, rows),
			cwd: dir,
			// TERM is what makes a shell emit colour and use cursor addressing at all.
			env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
		});

		const live: LiveTerminal = { pty: child, cwd: dir, attached: true, scrollback: [], bytes: 0, touched: Date.now() };

		child.onData((data) => {
			live.scrollback.push(data);
			live.bytes += data.length;
			while (live.bytes > SCROLLBACK_BYTES && live.scrollback.length > 1) {
				live.bytes -= live.scrollback.shift()?.length ?? 0;
			}
			if (live.attached) window()?.webContents.send("terminal:data", { id, data });
		});
		child.onExit(({ exitCode }) => {
			terminals.delete(id);
			window()?.webContents.send("terminal:exit", { id, code: exitCode });
		});
		terminals.set(id, live);
		return { id, pid: child.pid, replay: "" };
	};

	/**
	 * The pane has gone, the shell has not.
	 *
	 * Output carries on being recorded so the next attach can redraw it; it just stops being sent
	 * to a renderer with nothing to show it in.
	 */
	const detach = (id: string): void => {
		const live = terminals.get(id);
		if (live) live.attached = false;
	};

	const write = (id: string, data: string): void => {
		terminals.get(id)?.pty.write(data);
	};

	const resize = (id: string, cols: number, rows: number): void => {
		// A zero dimension is fatal to the pty; the renderer can briefly report one mid-layout.
		try {
			terminals.get(id)?.pty.resize(Math.max(2, cols), Math.max(2, rows));
		} catch {}
	};

	const kill = (id: string): void => {
		terminals.get(id)?.pty.kill();
		terminals.delete(id);
	};

	return { attach, detach, write, resize, kill };
}


/** Make room by ending the detached shell nobody has come back to for longest. */
function retireIdle(terminals: Map<string, LiveTerminal>): void {
	while (terminals.size >= MAX_TERMINALS) {
		let oldest: [string, LiveTerminal] | null = null;
		for (const entry of terminals) {
			if (entry[1].attached) continue;
			if (!oldest || entry[1].touched < oldest[1].touched) oldest = entry;
		}
		// Every one of them is on screen: that is a layout the user built, not a leak.
		if (!oldest) return;
		oldest[1].pty.kill();
		terminals.delete(oldest[0]);
	}
}
