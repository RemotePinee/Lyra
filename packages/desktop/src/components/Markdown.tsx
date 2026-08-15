/**
 * Markdown renderer.
 *
 * Deliberately hand-written rather than `marked` + `dangerouslySetInnerHTML`: model output is
 * untrusted, and building React elements means every string goes through React's escaping.
 * Covers what assistant messages actually use — headings, nested lists, fences, tables,
 * inline code, emphasis, links.
 */

import { Fragment, type ReactNode } from "react";
import { CodeBlock } from "./CodeBlock.tsx";

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
	// The class rides alongside `prose-dw` rather than replacing it, so a caller can dial the
	// size or colour down — reasoning is secondary text — without losing the block styling.
	return <div className={`prose-dw ${className}`}>{renderBlocks(text)}</div>;
}

type Block =
	| { kind: "heading"; level: number; text: string }
	| { kind: "paragraph"; text: string }
	| { kind: "code"; lang: string; code: string }
	| { kind: "list"; ordered: boolean; items: ListItem[] }
	| { kind: "quote"; text: string }
	| { kind: "rule" }
	| { kind: "table"; header: string[]; rows: string[][] };

interface ListItem {
	text: string;
	children: Block[];
}

function renderBlocks(source: string): ReactNode {
	return parseBlocks(source.replace(/\r\n/g, "\n").split("\n")).map((block, index) => (
		<Fragment key={index}>{renderBlock(block, index)}</Fragment>
	));
}

function parseBlocks(lines: string[]): Block[] {
	const blocks: Block[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			i++;
			continue;
		}

		// Fenced code. An unterminated fence runs to the end rather than swallowing nothing,
		// which is what happens while a code block is still streaming in.
		const fence = /^\s*```(\S*)\s*$/.exec(line);
		if (fence) {
			const lang = fence[1] ?? "";
			const code: string[] = [];
			i++;
			while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
			i++;
			blocks.push({ kind: "code", lang, code: code.join("\n") });
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
			i++;
			continue;
		}

		if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
			blocks.push({ kind: "rule" });
			i++;
			continue;
		}

		if (/^\s*>\s?/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
			blocks.push({ kind: "quote", text: quoted.join("\n") });
			continue;
		}

		// Table: a header row followed by a separator row of dashes.
		if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
			const header = splitRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
			blocks.push({ kind: "table", header, rows });
			continue;
		}

		if (isListLine(line)) {
			const { list, next } = parseList(lines, i, indentOf(line));
			blocks.push(list);
			i = next;
			continue;
		}

		const paragraph: string[] = [];
		while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) paragraph.push(lines[i++]);
		if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
		else i++;
	}

	return blocks;
}

function isBlockStart(line: string): boolean {
	return (
		/^\s*```/.test(line) ||
		/^#{1,6}\s/.test(line) ||
		/^\s*>\s?/.test(line) ||
		/^\s*(---|\*\*\*|___)\s*$/.test(line) ||
		isListLine(line)
	);
}

function isListLine(line: string): boolean {
	return /^\s*([-*+]|\d+[.)])\s+/.test(line);
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/** Parse one list level; deeper-indented lines recurse into the current item's children. */
function parseList(lines: string[], start: number, baseIndent: number): { list: Block; next: number } {
	const first = /^\s*(\d+)[.)]\s+/.exec(lines[start]);
	const ordered = first !== null;
	const items: ListItem[] = [];
	let i = start;

	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			// A blank line only ends the list when the next content is not part of it.
			const lookahead = lines[i + 1];
			if (!lookahead || (!isListLine(lookahead) && indentOf(lookahead) <= baseIndent)) break;
			i++;
			continue;
		}

		const indent = indentOf(line);
		if (indent < baseIndent || !isListLine(line)) {
			if (indent > baseIndent && items.length > 0) {
				// Continuation text belonging to the previous item.
				items[items.length - 1].text += `\n${line.trim()}`;
				i++;
				continue;
			}
			break;
		}

		if (indent > baseIndent) {
			const nested = parseList(lines, i, indent);
			if (items.length > 0) items[items.length - 1].children.push(nested.list);
			i = nested.next;
			continue;
		}

		const marker = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
		items.push({ text: marker?.[1] ?? line.trim(), children: [] });
		i++;
	}

	return { list: { kind: "list", ordered, items }, next: i };
}

function splitRow(line: string): string[] {
	return line
		.replace(/^\s*\|/, "")
		.replace(/\|\s*$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function renderBlock(block: Block, _key: number): ReactNode {
	switch (block.kind) {
		case "heading": {
			const Tag = `h${Math.min(block.level, 4)}` as "h1" | "h2" | "h3" | "h4";
			return <Tag>{renderInline(block.text)}</Tag>;
		}
		case "paragraph":
			return <p>{renderInline(block.text)}</p>;
		case "code":
			return <CodeBlock lang={block.lang} code={block.code} />;
		case "rule":
			return <hr />;
		case "quote":
			return <blockquote>{renderBlocks(block.text)}</blockquote>;
		case "list": {
			const Tag = block.ordered ? "ol" : "ul";
			return (
				<Tag>
					{block.items.map((item, index) => (
						<li key={index}>
							{renderInline(item.text)}
							{item.children.map((child, childIndex) => (
								<Fragment key={childIndex}>{renderBlock(child, childIndex)}</Fragment>
							))}
						</li>
					))}
				</Tag>
			);
		}
		case "table":
			return (
				<div className="overflow-x-auto">
					<table>
						<thead>
							<tr>
								{block.header.map((cell, index) => (
									<th key={index}>{renderInline(cell)}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, cellIndex) => (
										<td key={cellIndex}>{renderInline(cell)}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		default:
			return null;
	}
}

/**
 * Inline formatting. Code spans are matched first and their contents are not re-scanned, so
 * `**not bold**` inside backticks stays literal.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let lastIndex = 0;
	let key = 0;

	for (const match of text.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > lastIndex) out.push(<Fragment key={key++}>{softBreaks(text.slice(lastIndex, index))}</Fragment>);
		const token = match[0];

		if (token.startsWith("`")) out.push(<code key={key++}>{token.slice(1, -1)}</code>);
		else if (token.startsWith("**") || token.startsWith("__")) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
		else if (token.startsWith("~~")) out.push(<del key={key++}>{token.slice(2, -2)}</del>);
		else if (token.startsWith("*")) out.push(<em key={key++}>{token.slice(1, -1)}</em>);
		else {
			const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
			if (link) {
				const href = link[2];
				const safe = href.startsWith("http://") || href.startsWith("https://");
				out.push(
					safe ? (
						<a
							key={key++}
							href={href}
							onClick={(event) => {
								event.preventDefault();
								void window.deepwise.system.openExternal(href);
							}}
						>
							{link[1]}
						</a>
					) : (
						<Fragment key={key++}>{link[1]}</Fragment>
					),
				);
			}
		}
		lastIndex = index + token.length;
	}

	if (lastIndex < text.length) out.push(<Fragment key={key++}>{softBreaks(text.slice(lastIndex))}</Fragment>);
	return out;
}

function softBreaks(text: string): ReactNode {
	const parts = text.split("\n");
	if (parts.length === 1) return text;
	return parts.map((part, index) => (
		<Fragment key={index}>
			{index > 0 && <br />}
			{part}
		</Fragment>
	));
}
