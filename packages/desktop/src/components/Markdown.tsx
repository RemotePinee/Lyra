/**
 * Markdown renderer.
 *
 * Hand-written rather than `marked` + `dangerouslySetInnerHTML`: model output and other people's
 * pull request descriptions are both untrusted, and building React elements means every string
 * goes through React's escaping on the way in.
 *
 * This file is only the drawing. Which lines are a table and which characters are emphasis are
 * decided in `markdown-blocks.ts` and `markdown-inline.ts`, where they can be tested.
 */

import { ChevronRight, ExternalLink } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { CodeBlock } from "./CodeBlock.tsx";
import type { Block, ListItem } from "./markdown-blocks.ts";
import { parseMarkdown } from "./markdown-blocks.ts";
import { type Inline, parseInline } from "./markdown-inline.ts";
import { renderMath } from "./markdown-math.ts";
import { stripEmoji } from "./strip-emoji.ts";

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
	/*
	 * System emoji come out first.
	 *
	 * Everything that reaches this component was written somewhere else — a pull request
	 * description, a review comment, a model's reply — and a colour emoji dropped into a screen of
	 * single-weight line icons is drawn by the OS from another font, in colours from nobody's
	 * palette. One `🤖` in a description is the loudest thing on the page by accident.
	 *
	 * Here rather than at each call site, because this is the one door remote prose comes through.
	 */
	const clean = stripEmoji(text);

	// The class rides alongside `prose-dw` rather than replacing it, so a caller can dial the
	// size or colour down — reasoning is secondary text — without losing the block styling.
	/*
	 * `min-w-0`, because this is often a flex child and its contents are not all shrinkable.
	 *
	 * A flex item defaults to `min-width: auto`, which means "at least as wide as my contents" —
	 * and a code block holding an unbroken 40-character hash has contents that do not wrap. Without
	 * this the item grows to fit it, `pre`'s own `overflow-x` never comes into play because there
	 * is nothing left to overflow, and the width is pushed up through every ancestor instead.
	 */
	return <div className={`prose-dw min-w-0 ${className}`}>{renderBlocks(clean)}</div>;
}

function renderBlocks(source: string): ReactNode {
	return parseMarkdown(source).map((block, index) => <Fragment key={index}>{renderBlock(block)}</Fragment>);
}

function renderBlock(block: Block): ReactNode {
	switch (block.kind) {
		case "heading": {
			const Tag = `h${Math.min(block.level, 4)}` as "h1" | "h2" | "h3" | "h4";
			return <Tag>{inline(block.text)}</Tag>;
		}
		case "paragraph":
			return <p>{inline(block.text)}</p>;
		case "code":
			return <CodeBlock lang={block.lang} code={block.code} />;
		case "rule":
			return <hr />;
		case "quote":
			return <blockquote>{renderBlocks(block.text)}</blockquote>;
		case "math":
			return <MathBlock tex={block.tex} />;
		case "details":
			return <Details summary={block.summary} blocks={block.children} />;
		case "list": {
			const Tag = block.ordered ? "ol" : "ul";
			return (
				<Tag>
					{block.items.map((item, index) => (
						<Item key={index} item={item} />
					))}
				</Tag>
			);
		}
		case "table":
			return (
				<div className="ly-table">
					<table>
						<thead>
							<tr>
								{block.header.map((cell, index) => (
									<th key={index} style={{ textAlign: block.align[index] ?? "left" }}>
										{inline(cell)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, cellIndex) => (
										<td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? "left" }}>
											{inline(cell)}
										</td>
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

function Item({ item }: { item: ListItem }) {
	const body = (
		<>
			{inline(item.text)}
			{item.children.map((child, index) => (
				<Fragment key={index}>{renderBlock(child)}</Fragment>
			))}
		</>
	);

	if (item.checked === undefined) return <li>{body}</li>;
	return (
		<li className="ly-task" data-done={item.checked}>
			{/* Drawn, not an <input>: this reflects what the author wrote, and is not a control. */}
			<span aria-hidden className="ly-task-box">
				{item.checked && (
					<svg viewBox="0 0 12 12" fill="none" aria-hidden>
						<path d="M2.5 6.2 4.8 8.5 9.5 3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				)}
			</span>
			<span>{body}</span>
		</li>
	);
}

/** `<details>`, folded, with the same motion as every other disclosure in the app. */
function Details({ summary, blocks }: { summary: string; blocks: Block[] }) {
	const [open, setOpen] = useState(false);

	return (
		<div className="ly-details" data-open={open}>
			<button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="ly-details-summary">
				<ChevronRight size={13} strokeWidth={2} className="ly-details-chevron" />
				<span>{inline(summary)}</span>
			</button>
			<div className="ly-reveal" data-open={open} aria-hidden={!open}>
				<div>
					<div className="ly-details-body">
						{blocks.map((child, index) => (
							<Fragment key={index}>{renderBlock(child)}</Fragment>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

function MathBlock({ tex }: { tex: string }) {
	const html = renderMath(tex, true);
	// TeX that does not parse is shown as it was written; a red error box helps nobody read it.
	if (!html) return <pre className="ly-math-raw">{tex}</pre>;
	// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX's own output, built from a parse tree it escapes.
	return <div className="ly-math-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

function inline(text: string): ReactNode[] {
	return renderTokens(parseInline(text));
}

function renderTokens(tokens: Inline[]): ReactNode[] {
	return tokens.map((token, index) => <Fragment key={index}>{renderToken(token)}</Fragment>);
}

function renderToken(token: Inline): ReactNode {
	switch (token.kind) {
		case "text":
			return token.text;
		case "code":
			return <code>{token.text}</code>;
		case "break":
			return <br />;
		case "strong":
			return <strong>{renderTokens(token.children)}</strong>;
		case "em":
			return <em>{renderTokens(token.children)}</em>;
		case "del":
			return <del>{renderTokens(token.children)}</del>;
		case "tag": {
			const Tag = token.name;
			return <Tag>{renderTokens(token.children)}</Tag>;
		}
		case "math": {
			const html = renderMath(token.tex, false);
			if (!html) return `$${token.tex}$`;
			// biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX's own output, built from a parse tree it escapes.
			return <span className="ly-math" dangerouslySetInnerHTML={{ __html: html }} />;
		}
		case "link":
			return <Link href={token.href}>{renderTokens(token.children)}</Link>;
		case "image":
			return <Image src={token.src} alt={token.alt} />;
		default:
			return null;
	}
}

/** Only http(s) opens, and it opens outside — nothing navigates this window away from the app. */
function Link({ href, children }: { href: string; children: ReactNode }) {
	const safe = href.startsWith("http://") || href.startsWith("https://");
	if (!safe) return <>{children}</>;
	return (
		<a
			href={href}
			onClick={(event) => {
				event.preventDefault();
				void window.lyra.system.openExternal(href);
			}}
		>
			{children}
		</a>
	);
}

/**
 * A picture from somewhere else.
 *
 * The page's `img-src` is `self data: blob:`, so a remote screenshot cannot be drawn here, and
 * widening it for pull request bodies would widen it for every comment anybody can write. A named
 * link that opens in the browser keeps the reference — and its filename — rather than dropping it.
 */
function Image({ src, alt }: { src: string; alt: string }) {
	const local = src.startsWith("data:") || src.startsWith("blob:");
	if (local) return <img src={src} alt={alt} className="ly-md-image" />;

	const name = alt || decodeURIComponent(src.split("/").pop()?.split("?")[0] || "图片");
	return (
		<Link href={src}>
			<span className="ly-md-image-link">
				<ExternalLink size={11.5} strokeWidth={1.9} />
				{name}
			</span>
		</Link>
	);
}
