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
 * A directory can have several, which is what the pane's tabs are: `open` always starts a new one,
 * `list` reports what a project already has, and `attach` connects to one by id.
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
	/** What the tab is called. Numbered per directory, and kept when its neighbours close. */
	title: string;
	/** Raw output, in the chunks it arrived in, capped by `SCROLLBACK_BYTES`. */
	scrollback: string[];
	bytes: number;
	/**
	 * A counter, not a clock: which shell was returned to most recently.
	 *
	 * `Date.now()` cannot separate two attaches in the same millisecond, which made "retire the
	 * one idle longest" a coin toss between them — and would have gone wrong in the same way if
	 * the system clock ever stepped backwards.
	 */
	touched: number;
	/**
	 * Which connection is the current one.
	 *
	 * Bumped by every attach, and quoted back by `detach`. React mounts an effect twice in
	 * development, and the first mount's cleanup lands after the second has already connected —
	 * without this, that stale cleanup detached a shell somebody was listening to and the terminal
	 * went silent for good.
	 */
	epoch: number;
}

/** One shell in a directory, as the tab strip lists it. */
export interface TerminalTab {
	id: string;
	title: string;
}

/** What a pane gets back when it connects. */
export interface Attached {
	id: string;
	title: string;
	pid: number;
	/** This connection's number, to be quoted back to `detach`. */
	epoch: number;
	/** Everything the shell has written, for redrawing a pane that came back. */
	replay: string;
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
 * How many shells may be alive at once, across every project.
 *
 * They survive their panes, so without a ceiling a week of moving between projects would leave
 * dozens running. When the ceiling is reached it is another project's idle shell that goes: the
 * tabs of the project in front of you are a thing you opened deliberately, and closing one of
 * those to make room for another would be the app taking away work you can see.
 */
const MAX_TERMINALS = 16;

/** Ticks once per attach, so "used most recently" is an order rather than a timestamp. */
let clock = 0;

/**
 * The behaviour, with no Electron in it.
 *
 * Separated from the IPC handlers in `ipc/terminal.ts` so it can be driven directly: which shell an attach lands
 * on, what a detach leaves running and which one gets retired are the whole point of this file,
 * and they are decided here rather than in a message handler.
 */
export function createTerminalRegistry({ terminals, spawnPty, insideAProject, window }: TerminalDeps) {
	/** Where a terminal for this path actually starts: the project, or home if it is not one. */
	const resolve = (cwd: string): string => (insideAProject(cwd) ? cwd : process.env.HOME || process.cwd());

	/** Every shell this directory has, in the order they were opened. */
	const list = (cwd: string): TerminalTab[] =>
		[...terminals]
			.filter(([, live]) => live.cwd === resolve(cwd))
			.map(([id, live]) => ({ id, title: live.title }));

	/**
	 * Start another shell here.
	 *
	 * Always a new one — this is what the tab strip's `+` does. Joining an existing shell is
	 * `attach`, and which of them a freshly opened pane wants is the pane's decision.
	 */
	const open = (cwd: string, cols: number, rows: number): Attached => {
		const dir = resolve(cwd);
		retireIdle(terminals, dir);

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

		const live: LiveTerminal = {
			pty: child,
			cwd: dir,
			title: nextTitle(terminals, dir),
			attached: true,
			scrollback: [],
			bytes: 0,
			touched: ++clock,
			epoch: 1,
		};

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
		return { id, title: live.title, pid: child.pid, epoch: 1, replay: "" };
	};

	/**
	 * Connect a pane to a shell that already exists.
	 *
	 * Returns what the pane needs to redraw itself: everything the shell has written, and an
	 * `epoch` identifying this particular connection, to be handed back to `detach`. `null` if
	 * that shell is gone — it may have exited while the pane was away, and the pane decides what
	 * to do about that rather than being handed a surprise new shell.
	 */
	const attach = (id: string, cols: number, rows: number): Attached | null => {
		const live = terminals.get(id);
		if (!live) return null;

		live.attached = true;
		live.touched = ++clock;
		live.epoch++;
		/*
		 * The pane it left is not the pane it came back to: the dock may have resized in between,
		 * and a shell told nothing wraps every line to a width that is no longer there. A caller
		 * that does not know the size yet passes nothing and is not allowed to shrink the shell to
		 * a sliver on its way to finding out.
		 */
		if (cols > 0 && rows > 0) {
			try {
				live.pty.resize(Math.max(2, cols), Math.max(2, rows));
			} catch {}
		}
		return { id, title: live.title, pid: live.pty.pid, epoch: live.epoch, replay: live.scrollback.join("") };
	};

	/**
	 * The pane has gone, the shell has not.
	 *
	 * Output carries on being recorded so the next attach can redraw it; it just stops being sent
	 * to a renderer with nothing to show it in.
	 *
	 * Ignored unless it names the connection that is actually current — see `epoch`.
	 */
	const detach = (id: string, epoch: number): void => {
		const live = terminals.get(id);
		if (live && live.epoch === epoch) live.attached = false;
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

	return { list, open, attach, detach, write, resize, kill };
}


/**
 * Make room, without touching the project in front of you.
 *
 * Candidates are idle shells belonging to some other directory, oldest first. If there are none —
 * everything alive is either on screen or a tab of the current project — the ceiling yields. A
 * shell the user opened and can see is not a leak, and ending one to satisfy a number would be
 * the app closing a tab behind their back.
 */
function retireIdle(terminals: Map<string, LiveTerminal>, keep: string): void {
	while (terminals.size >= MAX_TERMINALS) {
		let oldest: [string, LiveTerminal] | null = null;
		for (const entry of terminals) {
			if (entry[1].attached || entry[1].cwd === keep) continue;
			if (!oldest || entry[1].touched < oldest[1].touched) oldest = entry;
		}
		if (!oldest) return;
		oldest[1].pty.kill();
		terminals.delete(oldest[0]);
	}
}

/** `终端 1`, `终端 2`, … per directory, never reusing a number a live tab still has. */
function nextTitle(terminals: Map<string, LiveTerminal>, cwd: string): string {
	const taken = new Set([...terminals.values()].filter((live) => live.cwd === cwd).map((live) => live.title));
	for (let n = 1; ; n++) {
		const title = `终端 ${n}`;
		if (!taken.has(title)) return title;
	}
}
