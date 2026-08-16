import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { SquareTerminal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PanelEmpty } from "./PanelEmpty.tsx";
import { useApp } from "../store.ts";
import { useSide } from "../sideStore.ts";

/**
 * A real shell, in the panel.
 *
 * A pseudo-terminal rather than a command runner: the difference is whether the program on the
 * other end believes it is talking to a person. Without a pty there is no colour, no prompt
 * redraw, no Ctrl-C, and anything full-screen — an editor, a pager, an interactive installer —
 * is simply unusable. Those are most of the reasons to want a terminal at all.
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
	const [exited, setExited] = useState<number | null>(null);

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

		let disposed = false;
		/*
		 * Output that arrived before we learned our own id.
		 *
		 * The shell starts writing the moment it is spawned — the prompt is usually out before
		 * `create` has even resolved — but until it does, an incoming chunk cannot be matched to
		 * this terminal. Dropping those is why the pane came up blank while the pty underneath
		 * was working perfectly. Held by id, so a second terminal's output is never replayed
		 * into this one.
		 */
		const early = new Map<string, string[]>();

		void window.lyra.terminal.create(cwd, terminal.cols, terminal.rows).then((id) => {
			// The panel can be closed before the shell finishes starting.
			if (disposed) {
				window.lyra.terminal.kill(id);
				return;
			}
			sessionId.current = id;
			setReady(true);
			for (const chunk of early.get(id) ?? []) terminal.write(chunk);
			early.clear();
			terminal.onData((data) => window.lyra.terminal.write(id, data));
			terminal.focus();
		});

		const offData = window.lyra.terminal.onData(({ id, data }) => {
			if (id === sessionId.current) terminal.write(data);
			else if (sessionId.current === null) early.set(id, [...(early.get(id) ?? []), data]);
		});
		const offExit = window.lyra.terminal.onExit(({ id, code }) => {
			if (id !== sessionId.current) return;
			sessionId.current = null;
			setExited(code);
		});

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
			if (sessionId.current) window.lyra.terminal.resize(sessionId.current, terminal.cols, terminal.rows);
		});
		observer.observe(element);

		return () => {
			disposed = true;
			observer.disconnect();
			offData();
			offExit();
			if (sessionId.current) window.lyra.terminal.kill(sessionId.current);
			sessionId.current = null;
			terminal.dispose();
			term.current = null;
			fit.current = null;
		};
	}, [cwd]);

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

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<div ref={host} className="ly-term min-h-0 flex-1 px-2 pt-1.5" />
			{exited !== null && (
				<div className="shrink-0 px-3 pb-2 text-detail text-ink-faint">
					shell 已退出（代码 {exited}）。关掉这个标签再打开一个新的。
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
