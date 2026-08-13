import type { HighlightStyle, Language } from "@codemirror/language";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { highlightStyle, loadFenceLanguage, mountHighlightStyles, tokenize } from "./highlight.ts";

/**
 * One style for the whole app, not one per block.
 *
 * `HighlightStyle.define` generates a fresh set of class names on every call, so building it
 * per block would mean a `<style>` element per block — all defining the same colours under
 * different names.
 */
let shared: HighlightStyle | null = null;
function sharedStyle(): HighlightStyle {
	if (!shared) {
		shared = highlightStyle();
		mountHighlightStyles(shared);
	}
	return shared;
}

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
	const [copied, setCopied] = useState(false);
	const [language, setLanguage] = useState<Language | null>(null);

	/*
	 * Grammar fetched per language, colouring recomputed per edit.
	 *
	 * Grammars are dynamic imports — a transcript that only ever shows TypeScript should not pay
	 * for the Python and SQL parsers as well. While one is in flight the block renders as plain
	 * text, which is also what a reply still streaming its fence shows.
	 */
	useEffect(() => {
		if (!lang) return;
		let cancelled = false;
		void loadFenceLanguage(lang).then((result) => {
			if (!cancelled) setLanguage(result);
		});
		return () => {
			cancelled = true;
		};
	}, [lang]);

	const tokens = useMemo(() => {
		if (!language) return null;
		try {
			return tokenize(code, language, sharedStyle());
		} catch {
			// A half-written fence mid-stream is not a reason to lose the text.
			return null;
		}
	}, [code, language]);

	return (
		<div className="group relative">
			{lang && (
				<span className="absolute top-2.5 left-3.5 font-mono text-[10.5px] tracking-wide text-ink-faint select-none">
					{lang}
				</span>
			)}
			<button
				type="button"
				title="复制"
				onClick={() => {
					void navigator.clipboard.writeText(code);
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}}
				className="absolute top-2 right-2 hidden rounded-md border border-line bg-float p-1.5 text-ink-muted transition-colors group-hover:block hover:text-ink"
			>
				{copied ? <Check size={12} strokeWidth={2} className="text-ok" /> : <Copy size={12} strokeWidth={1.9} />}
			</button>
			<pre className={lang ? "pt-7" : undefined}>
				<code>
					{tokens
						? tokens.map((token, index) =>
								token.className ? (
									<span key={index} className={token.className}>
										{token.text}
									</span>
								) : (
									token.text
								),
							)
						: code}
				</code>
			</pre>
		</div>
	);
}
