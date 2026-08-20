import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { SquareTerminal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PanelEmpty } from "./PanelEmpty.tsx";
import { useApp } from "../store.ts";
import { useSide } from "../sideStore.ts";
import { useTerminals } from "../store/terminals.ts";

/**
 * A real shell, in the panel.
 *
 * A pseudo-terminal rather than a command runner: the difference is whether the program on the
 * other end believes it is talking to a person. Without a pty there is no colour, no prompt
 * redraw, no Ctrl-C, and anything full-screen — an editor, a pager, an interactive installer —
 * is simply unusable. Those are most of the reasons to want a terminal at all.
 *
 * The shell is not owned here. It lives in the main process, keyed by project directory, and this
 * connects to whichever of that project's shells the tab strip has selected. So this component
 * mounting is not a terminal starting, and it unmounting is not one ending — see
 * `electron/terminal-registry.ts`.
 */
export function TerminalPane() {
	const workspace = useApp((s) => s.workspace);
	const appearance = useApp((s) => s.settings?.appearance);
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<Terminal | null>(null);
	/** Flips once the pty exists, so a queued command knows when it can be written. */
	const [ready, setReady] = useState(false);
	const fit = useRef<FitAddon | null>(null);
	/** Held in a ref as well as state: the data handler runs before React re-renders. */
	const sessionId = useRef<string | null>(null);
	/** Which attach this pane is the owner of, so a superseded cleanup cannot mute the shell. */
	const connection = useRef(0);
	/**
	 * The terminal's measured size, for shells that have not been started yet.
	 *
	 * A shell wraps its output to the width it was given at birth, and nothing can re-wrap what it
	 * has already written — so this has to be the real width, not a guess. 80×24 is only ever used
	 * before anything has been measured, which in practice is never: the layout effect that
	 * measures runs before the effect that opens.
	 */
	const size = useRef({ cols: 80, rows: 24 });
	const [exited, setExited] = useState<number | null>(null);
	const tabs = useTerminals((s) => (workspace?.path ? s.tabs[workspace.path] : undefined)) ?? [];

	/*
	 * Run what the transcript handed over.
	 *
	 * Written with a newline because the button says "run": the user read the command, saw where
	 * it came from, and pressed it. Waiting for `ready` matters — the panel opens and the shell
	 * spawns in that order, so the command usually arrives before there is anywhere to put it.
	 */
	const pending = useSide((s) => s.pendingCommand);
	useEffect(() => {
		const id = sessionId.current;
		if (!pending || !ready || !id) return;
		/*
		 * Claimed before it is written, not after.
		 *
		 * In development the effect runs twice per mount, and with the command still queued on
		 * the second pass it was sent — and executed — twice. Clearing first makes the second
		 * pass find nothing to do, which is the only ordering that is safe for something that
		 * runs a command.
		 */
		useSide.getState().commandTaken();
		window.lyra.terminal.write(id, `${pending}\r`);
		term.current?.focus();
	}, [pending, ready]);

	const cwd = workspace?.path;
	const active = useTerminals((s) => (cwd ? s.active[cwd] : undefined));

	/*
	 * Find out what this project already has running before drawing anything.
	 *
	 * Coming back to a project with two shells in it should show two tabs and the one that was in
	 * front, not a third shell nobody asked for. Only when there is genuinely nothing does this
	 * open one — which is the first-ever visit, and the only time a terminal is actually started
	 * by looking at it.
	 */
	useEffect(() => {
		if (!cwd) return;
		let cancelled = false;
		void window.lyra.terminal.list(cwd).then(async (tabs) => {
			if (cancelled) return;
			if (tabs.length > 0) {
				useTerminals.getState().sync(cwd, tabs);
				return;
			}
			/*
			 * Born at the size it will be shown at.
			 *
			 * This used to say `80, 24`, and a shell started at 80 columns in a pane 38 wide wraps
			 * its first output to a width the screen does not have — so the greeting and any
			 * `.zshrc` complaints came out broken mid-word, and stayed broken, because the resize
			 * that follows only affects what has yet to be written.
			 *
			 * It looked intermittent because it was a race it usually won: a shell takes a few
			 * hundred milliseconds to say anything and the terminal is measured within one frame of
			 * being asked for, so the correction normally lands first. A busy main thread is all it
			 * takes to lose. `size` is what the last mounted terminal measured — see the layout
			 * effect below — and 80×24 only stands in when nothing has been measured yet.
			 */
			const opened = await window.lyra.terminal.open(cwd, size.current.cols, size.current.rows);
			if (cancelled) return;
			useTerminals.getState().sync(cwd, [{ id: opened.id, title: opened.title }]);
		});
		return () => {
			cancelled = true;
		};
	}, [cwd]);

	/*
	 * The terminal itself belongs to the pane, not to the shell it happens to be showing.
	 *
	 * Built as soon as there is a project, before anything is connected — because its measurement
	 * is what a *new* shell has to be born at, and the effect that opens one runs after this. Tied
	 * to the active tab instead, the first shell of a project was opened before any terminal
	 * existed and so at a guessed 80×24; in a pane 38 columns wide its greeting came out wrapped
	 * mid-word and stayed that way, since a later resize cannot re-wrap what is already written.
	 */
	useLayoutEffect(() => {
		const element = host.current;
		if (!element || !cwd) return;

		const terminal = new Terminal({
			fontFamily: readVar("--ly-code-font") || "ui-monospace, SFMono-Regular, Menlo, monospace",
			// The resolved step, not the raw setting: `--text-code` carries the default for when
			// nothing has been configured, so the terminal cannot drift from the diff viewer.
			fontSize: Number.parseFloat(readVar("--text-code")) || 12.5,
			lineHeight: 1.35,
			cursorBlink: true,
			// The panel draws its own edges; the terminal should sit flush inside them.
			theme: paletteFromTheme(),
			allowProposedApi: true,
			scrollback: 5000,
		});
		const fitter = new FitAddon();
		terminal.loadAddon(fitter);
		terminal.open(element);
		fitter.fit();
		term.current = terminal;
		fit.current = fitter;
		size.current = { cols: terminal.cols, rows: terminal.rows };

		/*
		 * The pty has to be told the new size, or every program running in it keeps wrapping to
		 * the old width — which looks like corruption rather than a stale dimension.
		 */
		const observer = new ResizeObserver(() => {
			try {
				fitter.fit();
			} catch {
				return;
			}
			size.current = { cols: terminal.cols, rows: terminal.rows };
			if (sessionId.current) window.lyra.terminal.resize(sessionId.current, terminal.cols, terminal.rows);
		});
		observer.observe(element);

		return () => {
			observer.disconnect();
			terminal.dispose();
			term.current = null;
			fit.current = null;
		};
	}, [cwd]);

	/*
	 * Connect the terminal to whichever tab is in front.
	 *
	 * Separate from building it, so switching tabs is a reset and a reconnection rather than a
	 * teardown — and so the terminal exists, and has been measured, before any shell is started.
	 */
	useEffect(() => {
		const terminal = term.current;
		if (!terminal || !cwd || !active) return;

		// Whatever the previous tab left on screen is not this tab's. The replay below redraws it.
		terminal.reset();

		let disposed = false;
		/*
		 * Output that arrived before we learned our own id.
		 *
		 * The shell starts writing the moment it is spawned — the prompt is usually out before
		 * `attach` has even resolved — but until it does, an incoming chunk cannot be matched to
		 * this terminal. Dropping those is why the pane came up blank while the pty underneath
		 * was working perfectly. Held by id, so a second terminal's output is never replayed
		 * into this one.
		 */
		const early = new Map<string, string[]>();
		/** The keystroke handler, bound only once a shell is on the other end of it. */
		let typing: { dispose(): void } | null = null;

		void window.lyra.terminal.attach(active, terminal.cols, terminal.rows).then((connected) => {
			// The shell can exit while the pane is away; the list effect above notices and moves
			// the strip on, which brings us back here with a tab that does exist.
			if (!connected) return;
			const { id, epoch, replay } = connected;
			// The panel can be closed before the shell finishes connecting.
			if (disposed) {
				window.lyra.terminal.detach(id, epoch);
				return;
			}
			sessionId.current = id;
			connection.current = epoch;
			setReady(true);
			/*
			 * Everything the shell wrote while there was no pane, before anything that arrived
			 * since — including the chunks caught below while `attach` was in flight.
			 *
			 * It is the raw byte stream, escape sequences and all, so writing it back is not a
			 * transcript being pasted in: xterm replays it and lands on exactly the screen the
			 * shell had. That is what makes coming back to a terminal feel like returning to it
			 * rather than opening a new one.
			 */
			if (replay) terminal.write(replay);
			for (const chunk of early.get(id) ?? []) terminal.write(chunk);
			early.clear();
			typing = terminal.onData((data) => window.lyra.terminal.write(id, data));
			terminal.focus();
		});

		const offData = window.lyra.terminal.onData(({ id, data }) => {
			if (id === sessionId.current) terminal.write(data);
			else if (sessionId.current === null) early.set(id, [...(early.get(id) ?? []), data]);
		});
		const offExit = window.lyra.terminal.onExit(({ id, code }) => {
			if (id !== sessionId.current) return;
			sessionId.current = null;
			// The tab goes with the shell that backed it: a strip listing a shell that has exited
			// is a list of things that do not exist.
			if (cwd) useTerminals.getState().remove(cwd, id);
			setExited(code);
		});

		return () => {
			disposed = true;
			offData();
			offExit();
			/*
			 * Unbind the keys before letting go of the shell.
			 *
			 * The terminal outlives this effect now, so a handler left behind would send the next
			 * tab's keystrokes to the shell this one was attached to.
			 */
			typing?.dispose();
			/*
			 * Detach, never kill.
			 *
			 * This runs whenever the pane goes away, and most of those are not the user finishing
			 * with the terminal: closing the pane, switching to a conversation whose layout has no
			 * terminal in it, or making another pane full screen. Killing here is what made all
			 * three of those silently end a running build and throw away the scrollback.
			 *
			 * The shell is ended by the shell — `exit`, or the app quitting.
			 */
			if (sessionId.current) window.lyra.terminal.detach(sessionId.current, connection.current);
			sessionId.current = null;
		};
	}, [cwd, active]);

	// Repaint on a theme change rather than rebuilding the shell under the user.
	useEffect(() => {
		if (term.current) term.current.options.theme = paletteFromTheme();
	}, [appearance]);

	if (!workspace) {
		return (
			<PanelEmpty icon={SquareTerminal} title="终端">
				先打开一个项目，终端会在它的目录里启动。
			</PanelEmpty>
		);
	}

	const empty = Boolean(cwd) && tabs.length === 0;

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{/*
			 * The terminal's element is always here, even with nothing to show in it.
			 *
			 * It used to be swapped for the empty state, which unmounted the node xterm had been
			 * attached to while xterm itself — built per project, not per tab — carried on holding a
			 * reference to it. Closing every tab and opening a new one then left the pane with a tab
			 * strip and no terminal at all. Hidden and covered rather than replaced, so the element
			 * xterm owns outlives every tab that comes and goes inside it.
			 */}
			<div ref={host} className={`ly-term min-h-0 flex-1 px-2 pt-1.5 ${empty ? "invisible" : ""}`} />

			{/*
			 * Every tab closed.
			 *
			 * Reachable, and it used to leave the pane a blank rectangle with nothing said — which
			 * reads as the terminal having crashed rather than as the last tab having been closed on
			 * purpose. The way out is the same + the header carries, offered here too because an
			 * empty pane is where you look.
			 */}
			{empty && cwd && (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-7 pb-6 text-center">
					<SquareTerminal size={30} strokeWidth={1.35} className="text-ink-faint" />
					<p className="text-label text-ink-muted">这里没有终端了。</p>
					<button
						type="button"
						onClick={() => {
							// The measured size, like everywhere else a shell is started — see `size`.
							void window.lyra.terminal.open(cwd, size.current.cols, size.current.rows).then((opened) => {
								useTerminals.getState().add(cwd, { id: opened.id, title: opened.title });
							});
						}}
						className="rounded-lg border border-hairline px-3 py-1.5 text-label text-ink transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover"
					>
						新建终端
					</button>
				</div>
			)}
			{exited !== null && (
				<div className="shrink-0 px-3 pb-2 text-detail text-ink-faint">
					shell 已退出（代码 {exited}）。
				</div>
			)}
		</div>
	);
}

function readVar(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * xterm needs literal colours, so the palette is read out of the live CSS variables.
 *
 * The sixteen ANSI slots are fixed rather than derived: they are what programs mean by "red"
 * and "green", and remapping them to the app's accent would make `git diff` lie about which
 * lines were added.
 */
function paletteFromTheme(): Terminal["options"]["theme"] {
	const dark = document.documentElement.classList.contains("dark");
	return {
		background: readVar("--color-shell") || (dark ? "#171717" : "#ffffff"),
		foreground: readVar("--color-ink") || (dark ? "#ededed" : "#1a1c1f"),
		cursor: readVar("--color-ink-muted"),
		cursorAccent: readVar("--color-shell"),
		selectionBackground: dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)",
		black: dark ? "#3b3b3b" : "#2c2c2c",
		red: dark ? "#f07171" : "#c8402f",
		green: dark ? "#7fc98a" : "#33803f",
		yellow: dark ? "#e3c07b" : "#9a6a00",
		blue: dark ? "#79b8ff" : "#2b62c6",
		magenta: dark ? "#c39ac9" : "#8a45a5",
		cyan: dark ? "#6fd2c8" : "#0f7d78",
		white: dark ? "#d6d6d6" : "#5f5f5f",
		brightBlack: dark ? "#6b6b6b" : "#8a8a8a",
		brightRed: dark ? "#ff8f8f" : "#d94f3d",
		brightGreen: dark ? "#98e3a3" : "#3d9950",
		brightYellow: dark ? "#f2d69a" : "#b07d0d",
		brightBlue: dark ? "#9ecbff" : "#3a76dd",
		brightMagenta: dark ? "#d6b3db" : "#9d59b8",
		brightCyan: dark ? "#8fe4db" : "#12938d",
		brightWhite: dark ? "#ffffff" : "#2c2c2c",
	};
}
