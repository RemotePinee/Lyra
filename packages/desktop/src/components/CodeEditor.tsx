import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	syntaxHighlighting,
} from "@codemirror/language";
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
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
				/*
				 * ⌘F opens it, and it opens at the top.
				 *
				 * `searchKeymap` alone was already bound, which is why the shortcut appeared to do
				 * nothing — the bindings need a panel to open, and without `search()` there was
				 * none. Top rather than bottom because the composer-shaped things in this app all
				 * sit at the bottom of their pane, and a find bar down there reads as one of them.
				 */
				search({ top: true }),
				/*
				 * The panel's own wording, in the app's language.
				 *
				 * CodeMirror builds these strings into the panel's DOM, so there is no way to
				 * translate it from the outside — `phrases` is the hook it provides for exactly
				 * this. Missing keys fall through to the English original rather than blanking.
				 */
				EditorState.phrases.of(SEARCH_PHRASES),
				syntaxHighlighting(highlightStyle()),
				EditorState.readOnly.of(Boolean(readOnly)),
				wrapping.current.of(wrap ? EditorView.lineWrapping : []),
				language.current.of([]),
				keymap.of([
					/*
					 * ⌘F toggles rather than only opens.
					 *
					 * `searchKeymap` binds it to open, so pressing it again with the panel already
					 * up did nothing at all — and the way out was a key you had to know about.
					 * The shortcut that summons a thing should dismiss it.
					 */
					{
						key: "Mod-f",
						preventDefault: true,
						run: (view) => (searchPanelOpen(view.state) ? closeSearchPanel(view) : openSearchPanel(view)),
					},
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

		/*
		 * Tooltips for the find bar, which is not ours to render.
		 *
		 * The buttons show a glyph now, so the words have to live somewhere — and `phrases` only
		 * controls the visible label. CodeMirror builds the panel on first open, so this watches
		 * for it rather than running once. The app's own tooltip is driven by an attribute
		 * precisely so a panel outside React's tree can still use it.
		 */
		const labelPanel = () => {
			/*
			 * Replace starts folded, behind a disclosure of its own.
			 *
			 * Eleven controls is more than a narrow pane can hold on one line, and unfolded they
			 * wrapped to three rows with the close button stranded on one by itself. Most finds
			 * never replace anything, so the second row is the part that should be asked for —
			 * which is what every editor with a find bar does.
			 */
			const panel = element.querySelector<HTMLElement>(".cm-panel.cm-search");
			// The app's floating surface, so the find card matches every menu and popover in it.
			panel?.classList.add("dw-glass", "dw-pop-down");
			if (panel && !panel.querySelector("[name=dw-replace-toggle]")) {
				const toggle = document.createElement("button");
				toggle.setAttribute("name", "dw-replace-toggle");
				toggle.setAttribute("type", "button");
				toggle.setAttribute("aria-label", "显示替换");
				toggle.dataset.dwTip = "显示替换";
				toggle.innerHTML = CHEVRON_RIGHT;
				toggle.addEventListener("click", () => {
					const open = panel.classList.toggle("dw-replace-open");
					toggle.setAttribute("aria-label", open ? "隐藏替换" : "显示替换");
					toggle.dataset.dwTip = open ? "隐藏替换" : "显示替换";
					toggle.innerHTML = open ? CHEVRON_DOWN : CHEVRON_RIGHT;
					if (open) panel.querySelector<HTMLInputElement>("input[name=replace]")?.focus();
				});
				panel.prepend(toggle);
			}

			for (const [name, hint] of Object.entries(SEARCH_TIPS)) {
				const button = element.querySelector<HTMLElement>(`.cm-search button[name=${name}]`);
				if (!button || button.querySelector("svg")) continue;
				// The icon replaces the word, so the word has to survive as the accessible name.
				button.setAttribute("aria-label", hint);
				button.dataset.dwTip = hint;
				button.innerHTML = SEARCH_ICONS[name] ?? "";
			}
			// The options are labels, and their text is hidden, so they need one too.
			const options = element.querySelectorAll<HTMLElement>(".cm-search label");
			for (const [i, hint] of ["区分大小写", "正则表达式", "全词匹配"].entries()) {
				const option = options[i];
				if (!option || option.querySelector("svg")) continue;
				option.setAttribute("aria-label", hint);
				option.dataset.dwTip = hint;
				// Appended, not assigned: the checkbox inside is what holds the option's state.
				option.insertAdjacentHTML("beforeend", OPTION_ICONS[i] ?? "");
			}
		};
		const panels = new MutationObserver(labelPanel);
		panels.observe(element, { childList: true, subtree: true });
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
 * The find/replace panel's wording.
 *
 * Keys are CodeMirror's own English strings; anything not listed keeps the original.
 */
/** Hover text for the icon-only buttons, keyed by CodeMirror's own `name` attribute. */
/**
 * The find bar's icons, as markup.
 *
 * Same set and same geometry as the lucide icons the rest of the app imports as components —
 * CodeMirror builds these buttons itself, so they cannot take a React child, and glyphs like
 * `↓` or `≡` borrowed from the text font sat next to real icons everywhere else and read as a
 * different program's toolbar.
 */
const icon = (paths: string, size = 13) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const SEARCH_ICONS: Record<string, string> = {
	next: icon('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
	prev: icon('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
	select: icon('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
	replace: icon(
		'<path d="M14 4a1 1 0 0 1 1-1"/><path d="M15 10a1 1 0 0 1-1-1"/><path d="M21 4a1 1 0 0 0-1-1"/><path d="M21 9a1 1 0 0 1-1 1"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a2 2 0 0 1 2-2h2"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
		14.5,
	),
	replaceAll: icon(
		'<path d="M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"/><path d="M14 4a1 1 0 0 1 1-1"/><path d="M15 10a1 1 0 0 1-1-1"/><path d="M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1"/><path d="M21 4a1 1 0 0 0-1-1"/><path d="M21 9a1 1 0 0 1-1 1"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5a2 2 0 0 1 2-2h2"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
		14.5,
	),
	close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};

/** Three options, in lucide's own find-bar icons. */
const OPTION_ICONS = [
	icon(
		'<path d="m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16"/><path d="M22 9v7"/><path d="M3.304 13h6.392"/><circle cx="18.5" cy="12.5" r="3.5"/>',
	),
	icon(
		'<path d="M17 3v10"/><path d="m12.67 5.5 8.66 5"/><path d="m12.67 10.5 8.66-5"/><path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"/>',
	),
	icon(
		'<circle cx="7" cy="12" r="3"/><path d="M10 9v6"/><circle cx="17" cy="12" r="3"/><path d="M14 7v8"/><path d="M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1"/>',
	),
];

const CHEVRON_RIGHT = icon('<path d="m9 18 6-6-6-6"/>');
const CHEVRON_DOWN = icon('<path d="m6 9 6 6 6-6"/>');

const SEARCH_TIPS: Record<string, string> = {
	next: "下一个",
	prev: "上一个",
	select: "选中全部匹配",
	replace: "替换当前",
	replaceAll: "全部替换",
	close: "关闭 (Esc)",
};

const SEARCH_PHRASES: Record<string, string> = {
	Find: "查找",
	Replace: "替换",
	next: "下一个",
	previous: "上一个",
	all: "全部",
	"match case": "区分大小写",
	"by word": "全词匹配",
	regexp: "正则",
	replace: "替换",
	"replace all": "全部替换",
	close: "关闭",
	"current match": "当前匹配",
	"replaced $ matches": "已替换 $ 处",
	"replaced match on line $": "已替换第 $ 行的匹配",
	"on line": "行",
};

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
		/*
		 * The find/replace panel, restyled to the app's controls.
		 *
		 * CodeMirror ships a functional panel that looks like a browser dialogue from 2005 —
		 * beige buttons, a 1px inset border, its own font. Everything here maps it onto the
		 * tokens the rest of the app uses, so the one moment you press ⌘F does not open a
		 * different application inside this one.
		 */
		/*
		 * The find bar floats over the code rather than pushing it down.
		 *
		 * As a full-width strip it had to be laid out like one: controls at the left, and a few
		 * hundred pixels of nothing to their right that read as an unfinished toolbar. Every
		 * editor worth copying puts find in a small card in the corner instead — it is a tool you
		 * summon, not a part of the chrome, and it costs the document no vertical space.
		 *
		 * `position: absolute` takes the panel container out of the flex column, so the editor
		 * keeps its full height and the card sits on top of the first line or two.
		 */
		".cm-panels": {
			position: "absolute",
			top: 0,
			right: 0,
			left: "auto",
			zIndex: 5,
			maxWidth: "100%",
			backgroundColor: "transparent",
			color: "var(--color-ink)",
			border: "none",
		},
		/*
		 * Width is fixed, not fitted.
		 *
		 * `fit-content` on a wrapping flex row resolves towards max-content — the width every
		 * control would need on a single line — which left a stretch of empty card between the
		 * last button and the close corner. A stated width makes both rows end at the same edge,
		 * which is what lets the replace actions line up under the navigation.
		 */
		".cm-panel.cm-search": {
			// The card grows from the corner it is pinned to, not from its own centre.
			transformOrigin: "top right",
			width: "440px",
			maxWidth: "100%",
			margin: "8px 10px",
			borderRadius: "10px",
			border: "1px solid var(--color-line)",
			padding: "6px 26px 6px 7px",
			display: "flex",
			flexWrap: "wrap",
			alignItems: "center",
			gap: "3px",
			fontFamily: "var(--dw-ui-font)",
			fontSize: "12px",
		},
		/*
		 * One zero-height full-width pseudo-element, used as a line break.
		 *
		 * The standard trick for forcing a break in a wrapping flex row. CodeMirror's own `<br>`
		 * sits at roughly the right point in the source but will not take a `flex-basis` — a
		 * replaced element ignores it — so it is hidden and this takes over.
		 */
		".cm-panel.cm-search br": { display: "none" },
		".cm-panel.cm-search::before": { content: '""', flex: "0 0 100%", height: 0, order: 5 },
		/*
		 * Reordered, because the source order is not the reading order.
		 *
		 * CodeMirror emits find, its buttons, the option checkboxes, close, then replace and its
		 * buttons — so laid out plainly the replace field lands in the middle of the checkboxes.
		 * This puts each row with its own controls: find with its options and navigation, then
		 * replace with the two things you can replace.
		 */
		/*
		 * The fields have a width, rather than taking whatever is going.
		 *
		 * Left to grow they filled the pane — in a wide panel that meant a 1,100px box to type a
		 * word into, with its buttons stranded at the far end and nothing in between. A find bar
		 * is a compact group of controls, so it stays one and sits at the left edge whatever the
		 * pane is doing. Both fields get the same cap, so in any pane wide enough to reach it the
		 * two rows line up without a spacer propping them apart.
		 *
		 * A cap rather than a basis: `flex-wrap` breaks the line before it shrinks anything, so a
		 * 240px basis in a narrow pane put each field on a row of its own and made the panel
		 * taller instead of narrower. Growing up to a limit collapses gracefully instead.
		 */
		".cm-panel.cm-search button[name=dw-replace-toggle]": {
			order: 0,
			width: "18px",
			height: "22px",
			padding: 0,
			border: "none",
			background: "transparent",
			color: "var(--color-ink-faint)",
			fontSize: "9px",
			lineHeight: "22px",
		},
		".cm-panel.cm-search button[name=dw-replace-toggle]:hover": { color: "var(--color-ink)" },
		".cm-panel.cm-search input[name=replace], .cm-panel.cm-search button[name=replace], .cm-panel.cm-search button[name=replaceAll], .cm-panel.cm-search::before":
			{ display: "none" },
		".cm-panel.cm-search.dw-replace-open input[name=replace], .cm-panel.cm-search.dw-replace-open button[name=replace], .cm-panel.cm-search.dw-replace-open button[name=replaceAll]":
			{ display: "inline-flex" },
		".cm-panel.cm-search.dw-replace-open::before": { display: "block" },
		".cm-panel.cm-search input[name=search]": { order: 1, flex: "1 1 36px", minWidth: "36px", maxWidth: "236px" },
		".cm-panel.cm-search [name=next], .cm-panel.cm-search [name=prev], .cm-panel.cm-search [name=select]": {
			order: 3,
		},
		".cm-panel.cm-search input[name=replace]": { order: 6, flex: "1 1 36px", minWidth: "36px", maxWidth: "236px", marginLeft: "23px" },
		".cm-panel.cm-search [name=replace], .cm-panel.cm-search [name=replaceAll]": { order: 7 },
		".cm-panel.cm-search button[name=replace]": { marginLeft: "auto" },
		".cm-textfield": {
			// Otherwise the flex basis is the content box and each field silently occupies 24px
			// more than it claims — enough, in a narrow pane, to push the close button off the row.
			boxSizing: "border-box",
			backgroundColor: "var(--color-input)",
			color: "var(--color-ink)",
			border: "1px solid var(--color-line)",
			borderRadius: "7px",
			padding: "0 8px",
			height: "24px",
			fontSize: "12px",
			fontFamily: "var(--dw-ui-font)",
			outline: "none",
		},
		".cm-textfield:focus": { borderColor: "var(--color-ink-faint)" },
		/*
		 * Icons, not sentences.
		 *
		 * Five text buttons and three checkbox labels wrapped onto four rows in a docked panel —
		 * a find bar taller than the code it was searching. The words move into `title` and the
		 * glyph carries the meaning, which is what every editor's find bar does.
		 *
		 * The label text is pushed out of view rather than removed: it is still the button's
		 * accessible name, and `display: none` on it would take that away.
		 */
		/*
		 * The icon buttons are tiles, not boxed buttons.
		 *
		 * CodeMirror tags them `cm-button`, which carries a border meant for a labelled button —
		 * so half the row (find, step, select all) sat in outlines while the other half (the
		 * three options, which are labels) did not. Same treatment for both: no chrome at rest,
		 * a filled tile under the pointer, exactly like the icon buttons elsewhere in the app.
		 */
		".cm-panel.cm-search button[name]": {
			position: "relative",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: "20px",
			height: "20px",
			padding: 0,
			border: "none",
			borderRadius: "6px",
			background: "transparent",
			fontSize: 0,
			color: "var(--color-ink-faint)",
			transition: "background-color 140ms ease, color 140ms ease",
		},
		".cm-panel.cm-search button[name]:hover": { background: "var(--color-card-hover)", color: "var(--color-ink)" },
		".cm-panel.cm-search button[name]:active": { background: "var(--color-elevated)" },

		/*
		 * The options become the three glyphs every find bar uses, on the first row.
		 *
		 * As words they took a row of their own and made the panel taller than the code it
		 * searches. `Aa`, `.*` and `ab` are the conventional marks, so they need no legend — and
		 * the hidden text is still the label the checkbox is announced with.
		 */
		".cm-panel.cm-search label": {
			order: 2,
			position: "relative",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: "20px",
			height: "20px",
			borderRadius: "6px",
			fontSize: 0,
			color: "var(--color-ink-faint)",
			transition: "background-color 140ms ease, color 140ms ease",
		},
		".cm-panel.cm-search label:hover": { background: "var(--color-card-hover)", color: "var(--color-ink)" },
		".cm-panel.cm-search label:active": { background: "var(--color-elevated)" },
		// The checkbox itself is redundant once the tile can show its own state.
		".cm-panel.cm-search label input[type=checkbox]": {
			position: "absolute",
			width: "100%",
			height: "100%",
			margin: 0,
			opacity: 0,
		},
		".cm-panel.cm-search label:has(:checked)": { background: "var(--color-card-hover)", color: "var(--color-accent)" },
		".cm-button": {
			backgroundColor: "transparent",
			backgroundImage: "none",
			color: "var(--color-ink-muted)",
			border: "1px solid var(--color-line)",
			borderRadius: "7px",
			padding: "0 9px",
			height: "26px",
			fontSize: "11.5px",
			fontFamily: "var(--dw-ui-font)",
		},
		".cm-button:hover": { backgroundColor: "var(--color-card-hover)", color: "var(--color-ink)" },
		".cm-button:active": { backgroundColor: "var(--color-card-hover)" },
		// The close affordance is an icon, not a control that needs a box round it.
		// Absolutely positioned by CodeMirror's base theme, so it sits outside the flex flow.
		/*
		 * Out of the flow and in the corner.
		 *
		 * The card's corner, like any dismissable card. It was in the flow while the panel was a
		 * full-width strip — out there the corner was hundreds of pixels from everything else —
		 * but the card is 250px wide, so the corner is right next to the controls it closes.
		 */
		".cm-panel.cm-search button[name=close]": {
			position: "absolute",
			top: "4px",
			right: "4px",
			width: "20px",
			height: "20px",
			border: "none",
			background: "transparent",
			padding: 0,
		},
		".cm-panel.cm-search button[name=close]:hover": { background: "var(--color-card-hover)", borderRadius: "5px" },
		".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--color-info) 24%, transparent)" },
		".cm-searchMatch.cm-searchMatch-selected": {
			backgroundColor: "color-mix(in srgb, var(--color-accent) 42%, transparent)",
		},
		".cm-foldPlaceholder": {
			backgroundColor: "var(--color-card)",
			border: "none",
			color: "var(--color-ink-muted)",
			padding: "0 6px",
			borderRadius: "4px",
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
