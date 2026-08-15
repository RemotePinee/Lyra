/**
 * Which attributes a JSX tag carries, read straight out of the source text.
 *
 * Small enough not to need a parser, careful enough not to be a regex. The reason it exists is one
 * specific mistake: a naive scan for `title=` inside a tag walks backwards to the opening `<` and
 * stops at the first `>` it meets — which, in `onClick={() => close()}`, is the arrow. Attributes
 * after a handler are then invisible, so a check built on it reports a file clean because it never
 * looked at the interesting half.
 *
 * Scanning forwards from the tag name, with quotes and braces tracked, has no such blind spot.
 */

export interface TagAttribute {
	tag: string;
	name: string;
	/** Byte offset of the attribute name, for reporting a line. */
	index: number;
}

/** Every attribute of every JSX opening tag in `source`. */
export function tagAttributes(source: string): TagAttribute[] {
	const out: TagAttribute[] = [];
	for (const match of source.matchAll(/<([A-Za-z][\w.]*)/g)) {
		const tag = match[1];
		for (const attribute of attributesOf(source, match.index + match[0].length)) {
			out.push({ tag, name: attribute.name, index: attribute.index });
		}
	}
	return out;
}

/** Walk a tag from just after its name to its `>`, collecting attribute names at depth zero. */
function attributesOf(source: string, start: number): { name: string; index: number }[] {
	const out: { name: string; index: number }[] = [];
	let i = start;
	let depth = 0;

	while (i < source.length) {
		const ch = source[i];

		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipString(source, i);
			continue;
		}
		if (ch === "{") {
			depth++;
			i++;
			continue;
		}
		if (ch === "}") {
			depth--;
			i++;
			continue;
		}
		if (depth === 0 && ch === ">") return out;
		// A `<` at depth zero means the tag was never closed — malformed, or we started inside a string.
		if (depth === 0 && ch === "<") return out;

		if (depth === 0 && /[A-Za-z]/.test(ch)) {
			const name = /^[A-Za-z][\w:-]*/.exec(source.slice(i))?.[0] ?? "";
			// Only an assignment makes it an attribute; a bare word is `disabled` or a stray token.
			if (source[i + name.length] === "=") out.push({ name, index: i });
			i += name.length || 1;
			continue;
		}

		i++;
	}
	return out;
}

/** Past the closing quote of the string starting at `i`, escapes honoured. */
function skipString(source: string, i: number): number {
	const quote = source[i];
	for (let j = i + 1; j < source.length; j++) {
		if (source[j] === "\\") {
			j++;
			continue;
		}
		if (source[j] === quote) return j + 1;
	}
	return source.length;
}
