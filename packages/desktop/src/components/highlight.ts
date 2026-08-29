/**
 * Syntax colouring, shared by the file editor and by code blocks in the transcript.
 *
 * One place for both, because a `for` keyword that is purple in an open file and grey in a
 * reply about that file is the same fact told two different ways. The editor mounts these as
 * CodeMirror extensions; the transcript renders the same tags to spans without an editor.
 */

import { HighlightStyle, type Language, StreamLanguage, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { highlightTree, tags as t } from "@lezer/highlight";
import { findCodeTheme } from "./code-themes.ts";

/**
 * Token colours.
 *
 * `light-dark()` so one stylesheet serves both themes without a rebuild — the browser picks
 * per the `color-scheme` the root sets.
 */
export function highlightStyle(lightThemeId?: string, darkThemeId?: string): HighlightStyle {
	const light = findCodeTheme(lightThemeId, "light");
	const dark = findCodeTheme(darkThemeId, "dark");
	const c = (tag: keyof typeof light.tokens) => `light-dark(${light.tokens[tag]}, ${dark.tokens[tag]})`;

	return HighlightStyle.define([
		{ tag: [t.keyword, t.modifier, t.controlKeyword], color: c("keyword") },
		{ tag: [t.definitionKeyword, t.moduleKeyword], color: c("keyword") },
		{ tag: [t.string, t.special(t.string)], color: c("string") },
		{ tag: [t.number, t.bool, t.null, t.atom], color: c("number") },
		{ tag: [t.comment, t.blockComment, t.lineComment], color: c("comment"), fontStyle: "italic" },
		{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: c("function") },
		/*
		 * A key is a key, however the grammar spells it.
		 *
		 * JSON marks its keys `propertyName`, but YAML — and JavaScript object literals — mark
		 * theirs `definition(propertyName)`. Grouped with `definition(variableName)` it inherited
		 * the plain text colour, which is why a YAML file came out as an undifferentiated wall:
		 * every key the same weight as its value, with only quoted strings picking up any colour.
		 */
		{ tag: [t.definition(t.propertyName)], color: c("function") },
		{ tag: [t.definition(t.variableName)], color: c("variable") },
		/*
		 * Unquoted scalars, which is most of a YAML file's right-hand side.
		 *
		 * The grammar cannot tell `true` from `1.2.3` from a bare word — all three are `Literal`
		 * — so this cannot be split into booleans and numbers the way a typed language can. Plain
		 * text is the honest rendering: the key carries the colour, the value carries the weight.
		 */
		{ tag: [t.content], color: c("variable") },
		// Anchors and aliases (&name, *name) — references, so they read like other labels.
		{ tag: [t.labelName], color: c("keyword") },
		{ tag: [t.typeName, t.className, t.namespace], color: c("type") },
		{ tag: [t.propertyName], color: c("function") },
		{ tag: [t.variableName], color: c("variable") },
		{ tag: [t.operator, t.punctuation, t.separator, t.bracket], color: c("punctuation") },
		{ tag: [t.tagName], color: c("tag") },
		{ tag: [t.attributeName], color: c("attribute") },
		{ tag: [t.attributeValue], color: c("string") },
		{ tag: [t.heading], color: c("function"), fontWeight: "600" },
		{ tag: [t.link, t.url], color: c("function"), textDecoration: "underline" },
		{ tag: [t.emphasis], fontStyle: "italic" },
		{ tag: [t.strong], fontWeight: "600" },
		{ tag: [t.strikethrough], textDecoration: "line-through" },
		{ tag: [t.meta, t.processingInstruction], color: c("comment") },
		{ tag: [t.invalid], color: c("tag") },
		{ tag: [t.escape, t.regexp], color: c("attribute") },
	]);
}

/** Everything the editor knows how to colour, keyed by extension. */
/*
 * Booleans and numbers in YAML, which the grammar cannot label for us.
 *
 * Lezer marks every unquoted scalar `Literal` — `true`, `1.2.3` and a bare word are the same
 * node, because in YAML they genuinely are until something decides how to read them. That left
 * the right-hand side of a config file entirely uncoloured while JSON, whose grammar does carry
 * types, came out fully lit. This looks at the text of each `Literal` and marks the ones that
 * are unambiguously a boolean, a null or a number, which is the same judgement a reader makes.
 *
 * Keys are `Literal` too, under a `Key` parent — skipped, since they already have a colour.
 */
/** Shared with the editor theme, which colours the decorator below. */
export const ATOM = "light-dark(#a3562a, #dd9160)";

const YAML_BOOL = /^(?:true|false|yes|no|on|off)$/i;
const YAML_NULL = /^(?:null|~)$/i;
const YAML_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function yamlScalarMarks(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	for (const { from, to } of view.visibleRanges) {
		syntaxTree(view.state).iterate({
			from,
			to,
			enter: (node) => {
				if (node.name !== "Literal" || node.node.parent?.name === "Key") return;
				const text = view.state.doc.sliceString(node.from, node.to);
				if (YAML_BOOL.test(text) || YAML_NULL.test(text) || YAML_NUMBER.test(text)) {
					builder.add(node.from, node.to, ATOM_MARK);
				}
			},
		});
	}
	return builder.finish();
}

const ATOM_MARK = Decoration.mark({ class: "ly-yaml-atom" });

const yamlScalars = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = yamlScalarMarks(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) this.decorations = yamlScalarMarks(update.view);
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);

export const GRAMMARS: Record<string, () => Promise<Extension>> = {
	ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	mts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	cts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
	js: async () => (await import("@codemirror/lang-javascript")).javascript(),
	mjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
	cjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
	jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
	json: async () => (await import("@codemirror/lang-json")).json(),
	jsonc: async () => (await import("@codemirror/lang-json")).json(),
	md: async () => (await import("@codemirror/lang-markdown")).markdown(),
	mdx: async () => (await import("@codemirror/lang-markdown")).markdown(),
	css: async () => (await import("@codemirror/lang-css")).css(),
	scss: async () => (await import("@codemirror/lang-css")).css(),
	less: async () => (await import("@codemirror/lang-css")).css(),
	html: async () => (await import("@codemirror/lang-html")).html(),
	htm: async () => (await import("@codemirror/lang-html")).html(),
	vue: async () => (await import("@codemirror/lang-html")).html(),
	svelte: async () => (await import("@codemirror/lang-html")).html(),
	xml: async () => (await import("@codemirror/lang-xml")).xml(),
	svg: async () => (await import("@codemirror/lang-xml")).xml(),
	py: async () => (await import("@codemirror/lang-python")).python(),
	rs: async () => (await import("@codemirror/lang-rust")).rust(),
	go: async () => (await import("@codemirror/lang-go")).go(),
	java: async () => (await import("@codemirror/lang-java")).java(),
	kt: async () => (await import("@codemirror/lang-java")).java(),
	c: async () => (await import("@codemirror/lang-cpp")).cpp(),
	h: async () => (await import("@codemirror/lang-cpp")).cpp(),
	cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
	hpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
	cc: async () => (await import("@codemirror/lang-cpp")).cpp(),
	sql: async () => (await import("@codemirror/lang-sql")).sql(),
	yaml: async () => [(await import("@codemirror/lang-yaml")).yaml(), yamlScalars],
	yml: async () => [(await import("@codemirror/lang-yaml")).yaml(), yamlScalars],

	/*
	 * Everything below is a `StreamLanguage` from `@codemirror/legacy-modes`.
	 *
	 * These are line-oriented formats with no tree grammar, and they are most of what a project's
	 * configuration is actually written in: the shell scripts, the Dockerfile, the `.toml`, the
	 * `.env`. Before this they rendered as one flat colour — which for a file whose whole content
	 * is keys, values and comments means the comments do not read as comments.
	 *
	 * Loaded on demand like the rest, so opening a `.ts` file never pays for any of them.
	 */
	sh: async () => stream((await import("@codemirror/legacy-modes/mode/shell")).shell),
	bash: async () => stream((await import("@codemirror/legacy-modes/mode/shell")).shell),
	zsh: async () => stream((await import("@codemirror/legacy-modes/mode/shell")).shell),
	fish: async () => stream((await import("@codemirror/legacy-modes/mode/shell")).shell),
	toml: async () => stream((await import("@codemirror/legacy-modes/mode/toml")).toml),
	ini: async () => stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
	cfg: async () => stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
	conf: async () => stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
	properties: async () => stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
	env: async () => stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
	diff: async () => stream((await import("@codemirror/legacy-modes/mode/diff")).diff),
	patch: async () => stream((await import("@codemirror/legacy-modes/mode/diff")).diff),
	lua: async () => stream((await import("@codemirror/legacy-modes/mode/lua")).lua),
	rb: async () => stream((await import("@codemirror/legacy-modes/mode/ruby")).ruby),
	swift: async () => stream((await import("@codemirror/legacy-modes/mode/swift")).swift),
	ps1: async () => stream((await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
	psm1: async () => stream((await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
	pl: async () => stream((await import("@codemirror/legacy-modes/mode/perl")).perl),
	r: async () => stream((await import("@codemirror/legacy-modes/mode/r")).r),
	jl: async () => stream((await import("@codemirror/legacy-modes/mode/julia")).julia),
	hs: async () => stream((await import("@codemirror/legacy-modes/mode/haskell")).haskell),
	clj: async () => stream((await import("@codemirror/legacy-modes/mode/clojure")).clojure),
	ex: async () => stream((await import("@codemirror/legacy-modes/mode/erlang")).erlang),
	erl: async () => stream((await import("@codemirror/legacy-modes/mode/erlang")).erlang),
	scala: async () => stream((await import("@codemirror/legacy-modes/mode/clike")).scala),
	cs: async () => stream((await import("@codemirror/legacy-modes/mode/clike")).csharp),
	m: async () => stream((await import("@codemirror/legacy-modes/mode/clike")).objectiveC),
	dart: async () => stream((await import("@codemirror/legacy-modes/mode/clike")).dart),
	groovy: async () => stream((await import("@codemirror/legacy-modes/mode/groovy")).groovy),
	proto: async () => stream((await import("@codemirror/legacy-modes/mode/protobuf")).protobuf),
	nginx: async () => stream((await import("@codemirror/legacy-modes/mode/nginx")).nginx),
	cmake: async () => stream((await import("@codemirror/legacy-modes/mode/cmake")).cmake),
	tex: async () => stream((await import("@codemirror/legacy-modes/mode/stex")).stex),
	gitignore: async () => (await import("./ignore-mode.ts")).ignoreLanguage,
};

/** A legacy stream mode, wrapped as the extension CodeMirror 6 wants. */
function stream(mode: Parameters<typeof StreamLanguage.define>[0]): Extension {
	return StreamLanguage.define(mode);
}

/**
 * Files whose name *is* their type.
 *
 * `Dockerfile` has no extension, `.gitignore` is all extension, and `CMakeLists.txt` claims `.txt`
 * while being nothing of the sort. Checked before the extension for exactly that last reason.
 *
 * The ignore files share one grammar because they share one syntax — see `ignore-mode.ts`.
 */
export const BY_FILENAME: Record<string, string> = {
	dockerfile: "sh",
	containerfile: "sh",
	makefile: "sh",
	gnumakefile: "sh",
	"cmakelists.txt": "cmake",
	".gitignore": "gitignore",
	".dockerignore": "gitignore",
	".npmignore": "gitignore",
	".eslintignore": "gitignore",
	".prettierignore": "gitignore",
	".vercelignore": "gitignore",
	".gitattributes": "gitignore",
	".env": "env",
	".editorconfig": "ini",
	".babelrc": "json",
	".prettierrc": "json",
	".eslintrc": "json",
	".npmrc": "ini",
	".nvmrc": "properties",
	"nginx.conf": "nginx",
};

/**
 * Which grammar a file's name asks for, or null.
 *
 * One place, because three callers used to answer it differently: the editor looked at the
 * extension only, the fence renderer at the info string, and the diff at neither. A `Dockerfile`
 * was plain text in all three.
 */
export function grammarKeyFor(path: string): string | null {
	const name = path.toLowerCase().split(/[/\\]/).pop() ?? "";
	const byName = BY_FILENAME[name];
	if (byName) return GRAMMARS[byName] ? byName : null;

	// A leading dot is the whole name (`.env`), which the table above has already had its say on.
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	const extension = name.slice(dot + 1);
	return GRAMMARS[extension] ? extension : null;
}

/**
 * What a fenced block's info string means, in the names people actually write.
 *
 * Markdown fences are labelled by language (` ```typescript `), files by extension (`.ts`), and
 * the grammar table above is keyed by the latter. Only the aliases that differ are listed —
 * anything already spelt like its extension falls through unchanged.
 */
const FENCE_ALIASES: Record<string, string> = {
	typescript: "ts",
	javascript: "js",
	python: "py",
	rust: "rs",
	golang: "go",
	kotlin: "kt",
	"c++": "cpp",
	"objective-c": "c",
	markdown: "md",
	yml: "yaml",
};

/**
 * Colour a fenced block, without building an editor to do it.
 *
 * CodeMirror is the right answer for a file you can edit and the wrong one for forty snippets
 * in a transcript: each instance carries a view, a DOM subtree and its own event handlers, for
 * text nobody is going to type into. Parsing with the same grammar and walking the tree gives
 * identical colours for a fraction of that.
 *
 * Returns null for a language nothing here can parse — a shell session, or no info string at
 * all — so the caller can render plain text rather than guessing.
 */
export async function loadFenceLanguage(info: string): Promise<Language | null> {
	const name = info.toLowerCase().trim().split(/[\s:,]/)[0];
	if (!name) return null;
	const load = GRAMMARS[FENCE_ALIASES[name] ?? name];
	if (!load) return null;
	try {
		const extension = await load();
		// `LanguageSupport` carries its language plus its extras; only the parser is wanted here.
		const support = extension as { language?: Language };
		return support.language ?? null;
	} catch {
		return null;
	}
}

export interface Token {
	text: string;
	/** CodeMirror's generated class for this tag, or "" for text no rule matched. */
	className: string;
}

/**
 * Split code into coloured runs.
 *
 * `highlightTree` only calls back for ranges that matched a rule, so the gaps between them —
 * whitespace, punctuation nothing claimed — have to be filled in or the text comes out with
 * pieces missing.
 */
export function tokenize(code: string, language: Language, style: HighlightStyle): Token[] {
	const tree = language.parser.parse(code);
	const tokens: Token[] = [];
	let at = 0;

	highlightTree(tree, style, (from, to, className) => {
		if (from > at) tokens.push({ text: code.slice(at, from), className: "" });
		tokens.push({ text: code.slice(from, to), className });
		at = to;
	});
	if (at < code.length) tokens.push({ text: code.slice(at), className: "" });

	return tokens;
}

/**
 * The same runs, split at line breaks.
 *
 * A diff is rendered one row per line, so it needs its colours cut the same way — and a token
 * can legitimately span lines (a block comment, a template literal), which is exactly the case
 * that colouring each line on its own gets wrong. Parsing the whole passage and dividing the
 * result afterwards keeps those spans intact.
 */
export function tokenizeLines(code: string, language: Language, style: HighlightStyle): Token[][] {
	const lines: Token[][] = [[]];
	for (const token of tokenize(code, language, style)) {
		const parts = token.text.split("\n");
		for (const [index, part] of parts.entries()) {
			if (index > 0) lines.push([]);
			if (part) lines[lines.length - 1].push({ text: part, className: token.className });
		}
	}
	return lines;
}

/**
 * Put the generated class definitions in the document, once.
 *
 * `HighlightStyle` hands CodeMirror a style module that the editor mounts on its own root.
 * Rendering the same classes outside an editor means the rules have to exist in the document
 * too, or every span comes out carrying a class name with nothing behind it.
 *
 * The rules are read out as text rather than mounted through `style-mod` directly: that package
 * is CodeMirror's own transitive dependency, and reaching past a dependency into what it happens
 * to pull in is how a working build breaks on an unrelated upgrade.
 */
let shared: HighlightStyle | null = null;
let currentLightId: string | undefined;
let currentDarkId: string | undefined;

/**
 * The one style for the whole app, mounted the first time anything asks.
 *
 * `HighlightStyle.define` generates a fresh set of class names on every call, and
 * `mountHighlightStyles` updates the rules in the document so changes to the light/dark code theme
 * propagate to every CodeBlock, DiffView, and FileViewer.
 */
export function sharedHighlightStyle(lightThemeId?: string, darkThemeId?: string): HighlightStyle {
	if (!shared || currentLightId !== lightThemeId || currentDarkId !== darkThemeId) {
		currentLightId = lightThemeId;
		currentDarkId = darkThemeId;
		shared = highlightStyle(lightThemeId, darkThemeId);
		mountHighlightStyles(shared);
	}
	return shared;
}

let highlightStyleEl: HTMLStyleElement | null = null;

export function mountHighlightStyles(style: HighlightStyle): void {
	const rules = style.module?.getRules();
	if (!rules) return;
	if (!highlightStyleEl) {
		highlightStyleEl = document.createElement("style");
		highlightStyleEl.dataset.dwHighlight = "";
		document.head.append(highlightStyleEl);
	}
	highlightStyleEl.textContent = rules;
}
