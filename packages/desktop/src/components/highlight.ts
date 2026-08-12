/**
 * Syntax colouring, shared by the file editor and by code blocks in the transcript.
 *
 * One place for both, because a `for` keyword that is purple in an open file and grey in a
 * reply about that file is the same fact told two different ways. The editor mounts these as
 * CodeMirror extensions; the transcript renders the same tags to spans without an editor.
 */

import { HighlightStyle, type Language } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { highlightTree, tags as t } from "@lezer/highlight";

/**
 * Token colours.
 *
 * `light-dark()` so one stylesheet serves both themes without a rebuild — the browser picks
 * per the `color-scheme` the root sets. The hues are the familiar editor conventions rather
 * than the app's accent: syntax colour is read as meaning, not as branding.
 */
export function highlightStyle(): HighlightStyle {
	const c = (light: string, dark: string) => `light-dark(${light}, ${dark})`;
	return HighlightStyle.define([
		{ tag: [t.keyword, t.modifier, t.controlKeyword], color: c("#8a45a5", "#c39ac9") },
		{ tag: [t.definitionKeyword, t.moduleKeyword], color: c("#8a45a5", "#c39ac9") },
		{ tag: [t.string, t.special(t.string)], color: c("#2f7d4f", "#7fc98a") },
		{ tag: [t.number, t.bool, t.null, t.atom], color: c("#a3562a", "#dd9160") },
		{ tag: [t.comment, t.blockComment, t.lineComment], color: c("#8a8d90", "#7e8184"), fontStyle: "italic" },
		{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: c("#2b62c6", "#79b8ff") },
		{ tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: c("#1a1c1f", "#ededed") },
		{ tag: [t.typeName, t.className, t.namespace], color: c("#0f7d78", "#6fd2c8") },
		{ tag: [t.propertyName], color: c("#2b62c6", "#79b8ff") },
		{ tag: [t.variableName], color: c("#1a1c1f", "#ededed") },
		{ tag: [t.operator, t.punctuation, t.separator, t.bracket], color: c("#6a6d70", "#9a9d9f") },
		{ tag: [t.tagName], color: c("#c8402f", "#f07171") },
		{ tag: [t.attributeName], color: c("#b07d0d", "#e3c07b") },
		{ tag: [t.attributeValue], color: c("#2f7d4f", "#7fc98a") },
		{ tag: [t.heading], color: c("#2b62c6", "#79b8ff"), fontWeight: "600" },
		{ tag: [t.link, t.url], color: c("#2b62c6", "#79b8ff"), textDecoration: "underline" },
		{ tag: [t.emphasis], fontStyle: "italic" },
		{ tag: [t.strong], fontWeight: "600" },
		{ tag: [t.strikethrough], textDecoration: "line-through" },
		{ tag: [t.meta, t.processingInstruction], color: c("#8a8d90", "#7e8184") },
		{ tag: [t.invalid], color: c("#c8402f", "#f07171") },
		{ tag: [t.escape, t.regexp], color: c("#b07d0d", "#e3c07b") },
	]);
}

/** Everything the editor knows how to colour, keyed by extension. */
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
	yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
	yml: async () => (await import("@codemirror/lang-yaml")).yaml(),
};

async function languageFor(path: string): Promise<Extension | null> {
	const name = path.toLowerCase().split("/").pop() ?? "";
	// Files that are configuration by name rather than by extension.
	if (name === "dockerfile" || name === "makefile") return null;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	const load = GRAMMARS[name.slice(dot + 1)];
	return load ? load().catch(() => null) : null;
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
let mounted = false;
export function mountHighlightStyles(style: HighlightStyle): void {
	if (mounted) return;
	const rules = style.module?.getRules();
	if (!rules) return;
	const element = document.createElement("style");
	element.dataset.dwHighlight = "";
	element.textContent = rules;
	document.head.append(element);
	mounted = true;
}
