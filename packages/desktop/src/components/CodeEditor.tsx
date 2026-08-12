import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
	EditorView,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef, useState } from "react";

import { GRAMMARS, highlightStyle } from "./highlight.ts";
import { OverlayScrollbar } from "./OverlayScrollbar.tsx";

/**
 * A real editor, not a `<pre>` with colours.
 *
 * CodeMirror rather than a highlighter: highlighting a string is the easy half, and the half
 * that stops mattering the moment you want to change a line. Selection, undo, bracket matching,
 * find, and an indent key that does the right thing are the difference between reading a file
 * here and copying it somewhere else to work on it.
 *
 * Languages load on demand. Bundling twenty grammars for the one file you opened would put
 * megabytes into the initial payload to support a panel that is usually closed.
 */
export function CodeEditor({
	path,
	text,
	readOnly,
	wrap,
	onChange,
	onSave,
}: {
	/** Identity of the document; changing it rebuilds the state, which resets undo history. */
	path: string;
	text: string;
	readOnly?: boolean;
	/** Soft-wrap long lines instead of scrolling sideways. */
	wrap?: boolean;
	onChange: (next: string) => void;
	onSave: () => void;
}) {
	const host = useRef<HTMLDivElement>(null);
	/*
	 * CodeMirror's scrolling element, which only exists once the view is built.
	 *
	 * State rather than a ref, because the thumbs have to render again once it appears — a ref
	 * assigned inside the mount effect would leave them measuring nothing on the first pass.
	 */
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	const scrollerRef = useRef<HTMLElement | null>(null);
	scrollerRef.current = scroller;
	const view = useRef<EditorView | null>(null);
	const language = useRef(new Compartment());
	/*
	 * Wrapping is reconfigured, not rebuilt.
	 *
	 * Putting `wrap` in the effect that builds the state would throw the document away and take
	 * the undo history, the selection and the scroll position with it — for a setting you toggle
	 * precisely to look at the line you are already on.
	 */
	const wrapping = useRef(new Compartment());
	/** Held in refs so the editor is never rebuilt just because a callback identity changed. */
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	onChangeRef.current = onChange;
	onSaveRef.current = onSave;

	useEffect(() => {
		const element = host.current;
		if (!element) return;

		const state = EditorState.create({
			doc: text,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightActiveLine(),
				drawSelection(),
				rectangularSelection(),
				history(),
				foldGutter(),
				indentOnInput(),
				bracketMatching(),
				highlightSelectionMatches(),
				syntaxHighlighting(highlightStyle()),
				EditorState.readOnly.of(Boolean(readOnly)),
				wrapping.current.of(wrap ? EditorView.lineWrapping : []),
				language.current.of([]),
				keymap.of([
					// Before the defaults, so ⌘S is ours rather than the browser's.
					{
						key: "Mod-s",
						preventDefault: true,
						run: () => {
							onSaveRef.current();
							return true;
						},
					},
					indentWithTab,
					...defaultKeymap,
					...historyKeymap,
					...searchKeymap,
					...foldKeymap,
				]),
				editorTheme(),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) onChangeRef.current(update.state.doc.toString());
				}),
			],
		});

		const instance = new EditorView({ state, parent: element });
		view.current = instance;
		setScroller(instance.scrollDOM);

		let live = true;
		void languageFor(path).then((extension) => {
			// The file can be closed while its grammar is still being fetched.
			if (live && extension) instance.dispatch({ effects: language.current.reconfigure(extension) });
		});

		return () => {
			live = false;
			instance.destroy();
			view.current = null;
			setScroller(null);
		};
		// `text` is deliberately absent: it seeds the document, and re-seeding on every
		// keystroke would fight the editor for control of its own content. `wrap` likewise —
		// it seeds the compartment above and is reconfigured, never rebuilt.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [path, readOnly]);

	useEffect(() => {
		view.current?.dispatch({
			effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
		});
	}, [wrap]);

	/*
	 * Adopt an outside change without disturbing the caret.
	 *
	 * Only when the incoming text genuinely differs from what is on screen — otherwise this
	 * fires on every keystroke, since our own `onChange` is what produced the new value.
	 */
	useEffect(() => {
		const instance = view.current;
		if (!instance) return;
		const current = instance.state.doc.toString();
		if (current === text) return;
		instance.dispatch({ changes: { from: 0, to: current.length, insert: text } });
	}, [text]);

	return (
		// `relative` so the thumbs can be positioned against the pane rather than the window.
		<div className="dw-scroll-host relative flex min-h-0 flex-1">
			<div ref={host} className="dw-cm min-h-0 min-w-0 flex-1 overflow-hidden" />
			{scroller && (
				<>
					<OverlayScrollbar viewport={scrollerRef} orientation="vertical" />
					<OverlayScrollbar viewport={scrollerRef} orientation="horizontal" />
				</>
			)}
		</div>
	);
}

/**
 * Chrome colours, taken from the app's own tokens.
 *
 * CodeMirror emits real CSS, so `var(...)` works here — which means the editor follows a theme
 * change with everything else instead of needing to be rebuilt.
 */
function editorTheme(): Extension {
	return EditorView.theme({
		"&": { backgroundColor: "transparent", color: "var(--color-ink)", height: "100%" },
		".cm-content": {
			fontFamily: "var(--dw-code-font)",
			fontSize: "12px",
			padding: "6px 0 40px",
			caretColor: "var(--color-ink)",
		},
		".cm-scroller": { overflow: "auto", lineHeight: "1.65" },
		"&.cm-focused": { outline: "none" },
		/*
		 * Opaque, because the gutter is pinned while the code scrolls under it.
		 *
		 * Transparent was fine for as long as lines always wrapped — nothing ever passed beneath.
		 * With wrapping off, a long line scrolls straight through the line numbers and the two
		 * render on top of each other. The fill has to be the pane's own colour rather than a
		 * tint, or the seam shows as a stripe down the left of every file.
		 */
		".cm-gutters": {
			backgroundColor: "var(--color-shell)",
			color: "var(--color-ink-faint)",
			border: "none",
			fontFamily: "var(--dw-code-font)",
			fontSize: "11px",
		},
		// Matches `.cm-activeLine` exactly, so the highlight reads as one band across both.
		".cm-activeLineGutter": {
			backgroundColor: "color-mix(in srgb, var(--color-ink) 4%, var(--color-shell))",
			color: "var(--color-ink-muted)",
		},
		".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-ink) 4%, transparent)" },
		".cm-selectionBackground, ::selection": {
			backgroundColor: "color-mix(in srgb, var(--color-info) 22%, transparent) !important",
		},
		".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-ink)" },
		".cm-matchingBracket": {
			backgroundColor: "color-mix(in srgb, var(--color-info) 18%, transparent)",
			outline: "none",
		},
		".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--color-info) 12%, transparent)" },
		".cm-foldPlaceholder": {
			backgroundColor: "var(--color-card)",
			border: "none",
			color: "var(--color-ink-muted)",
			padding: "0 6px",
			borderRadius: "4px",
		},
		".cm-panels": { backgroundColor: "var(--color-float)", color: "var(--color-ink)" },
		".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--color-info) 22%, transparent)" },
		".cm-searchMatch.cm-searchMatch-selected": {
			backgroundColor: "color-mix(in srgb, var(--color-info) 42%, transparent)",
		},
	});
}

/** The grammar for a path, or null when nothing here can parse it. */
async function languageFor(path: string): Promise<Extension | null> {
	const name = path.toLowerCase().split("/").pop() ?? "";
	// Files that are configuration by name rather than by extension.
	if (name === "dockerfile" || name === "makefile") return null;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	const load = GRAMMARS[name.slice(dot + 1)];
	return load ? load().catch(() => null) : null;
}

/** Which files this editor can colour at all — used to pick a viewer. */
export function isEditable(name: string): boolean {
	const lower = name.toLowerCase();
	if (lower === "dockerfile" || lower === "makefile" || lower.startsWith(".")) return true;
	const dot = lower.lastIndexOf(".");
	return dot > 0;
}
