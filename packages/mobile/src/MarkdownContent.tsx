import * as Clipboard from "expo-clipboard";
import React, { memo, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

export type Align = "left" | "center" | "right";

export interface TableBlock {
	kind: "table";
	header: string[];
	rows: string[][];
	align: Align[];
}

export interface CodeBlock {
	kind: "code";
	lang: string;
	code: string;
}

export interface HeadingBlock {
	kind: "heading";
	level: number;
	text: string;
}

export interface ListBlock {
	kind: "list";
	ordered: boolean;
	items: { text: string; checked?: boolean }[];
}

export interface ParagraphBlock {
	kind: "paragraph";
	text: string;
}

export interface QuoteBlock {
	kind: "quote";
	text: string;
}

export interface RuleBlock {
	kind: "rule";
}

export type MobileBlock =
	| HeadingBlock
	| ParagraphBlock
	| CodeBlock
	| ListBlock
	| QuoteBlock
	| RuleBlock
	| TableBlock;

export type InlineToken =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "strong"; text: string }
	| { kind: "em"; text: string }
	| { kind: "del"; text: string };

/**
 * Tokenize inline spans: `code`, **bold**, *italic*, ~~strikethrough~~
 */
export function parseInlineTokens(source: string): InlineToken[] {
	const tokens: InlineToken[] = [];
	const regex = /(`[^`]+`|\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*(?!\*)|~~[^~]+~~)/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(source)) !== null) {
		if (match.index > lastIndex) {
			tokens.push({ kind: "text", text: source.slice(lastIndex, match.index) });
		}
		const m = match[0];
		if (m.startsWith("`") && m.endsWith("`")) {
			tokens.push({ kind: "code", text: m.slice(1, -1) });
		} else if (m.startsWith("**") && m.endsWith("**")) {
			tokens.push({ kind: "strong", text: m.slice(2, -2) });
		} else if (m.startsWith("*") && m.endsWith("*")) {
			tokens.push({ kind: "em", text: m.slice(1, -1) });
		} else if (m.startsWith("~~") && m.endsWith("~~")) {
			tokens.push({ kind: "del", text: m.slice(2, -2) });
		}
		lastIndex = match.index + m.length;
	}

	if (lastIndex < source.length) {
		tokens.push({ kind: "text", text: source.slice(lastIndex) });
	}

	return tokens;
}

function splitTableRow(line: string): string[] {
	const trimmed = line.trim();
	const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	return inner.split("|").map((cell) => cell.trim());
}

function parseTableAlign(line: string): Align[] {
	return splitTableRow(line).map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		return "left";
	});
}

function isTableDelimiter(line: string): boolean {
	const trimmed = line.trim();
	return /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(trimmed);
}

/**
 * Full block-level parser aligned with Desktop's markdown-blocks
 */
export function parseBlocks(source: string): MobileBlock[] {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const blocks: MobileBlock[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			i++;
			continue;
		}

		// 1. Fenced Code Block: ```lang ... ```
		const fence = /^\s*(```+|~~~+)(\S*)\s*$/.exec(line);
		if (fence) {
			const marker = fence[1][0];
			const lang = fence[2] ?? "";
			const codeLines: string[] = [];
			const closeRegex = marker === "`" ? /^\s*```+\s*$/ : /^\s*~~~+\s*$/;
			i++;
			while (i < lines.length && !closeRegex.test(lines[i])) {
				codeLines.push(lines[i++]);
			}
			i++; // skip closing fence
			blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
			continue;
		}

		// 2. Headings: # ## ### ####
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
			i++;
			continue;
		}

		// 3. Horizontal Rule: ---, ***, ___
		if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
			blocks.push({ kind: "rule" });
			i++;
			continue;
		}

		// 4. Blockquote: > text
		if (/^\s*>\s?/.test(line)) {
			const quoteLines: string[] = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
				quoteLines.push(lines[i++].replace(/^\s*>\s?/, ""));
			}
			blocks.push({ kind: "quote", text: quoteLines.join("\n") });
			continue;
		}

		// 5. Tables: | col | col | followed by delimiter row |:---|:---|
		if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
			const header = splitTableRow(line);
			const align = parseTableAlign(lines[i + 1]);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i].includes("|") && lines[i].trim() && !isTableDelimiter(lines[i])) {
				rows.push(splitTableRow(lines[i++]));
			}
			blocks.push({ kind: "table", header, rows, align });
			continue;
		}

		// 6. Lists: bullet - / * / + or numbered 1.
		const listMatch = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
		if (listMatch) {
			const ordered = /^\d+\./.test(listMatch[1]);
			const items: { text: string; checked?: boolean }[] = [];
			while (i < lines.length) {
				const curr = lines[i];
				const match = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(curr);
				if (!match) break;
				let itemText = match[2].trim();
				let checked: boolean | undefined = undefined;
				if (itemText.startsWith("[ ] ")) {
					checked = false;
					itemText = itemText.slice(4);
				} else if (itemText.startsWith("[x] ") || itemText.startsWith("[X] ")) {
					checked = true;
					itemText = itemText.slice(4);
				}
				items.push({ text: itemText, checked });
				i++;
			}
			blocks.push({ kind: "list", ordered, items });
			continue;
		}

		// 7. Plain Paragraph (collecting multi-line body)
		const paragraph: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() &&
			!/^\s*(```+|~~~+)/.test(lines[i]) &&
			!/^#{1,6}\s/.test(lines[i]) &&
			!/^\s*(---|\*\*\*|___)\s*$/.test(lines[i]) &&
			!/^\s*>\s?/.test(lines[i]) &&
			!(lines[i].includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) &&
			!/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
		) {
			paragraph.push(lines[i++]);
		}
		if (paragraph.length > 0) {
			blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
		} else {
			i++;
		}
	}

	return blocks;
}

/**
 * Render inline tokens into Text elements
 */
export function RenderInline({ text }: { text: string }) {
	const tokens = parseInlineTokens(text);

	return (
		<>
			{tokens.map((token, idx) => {
				switch (token.kind) {
					case "code":
						return (
							<Text
								key={idx}
								className="rounded bg-card/80 px-1.5 py-0.5 font-mono text-[12.5px] text-[#ff9f43]"
							>
								{token.text}
							</Text>
						);
					case "strong":
						return (
							<Text key={idx} className="font-bold text-ink">
								{token.text}
							</Text>
						);
					case "em":
						return (
							<Text key={idx} className="italic text-ink">
								{token.text}
							</Text>
						);
					case "del":
						return (
							<Text key={idx} className="line-through text-ink-muted">
								{token.text}
							</Text>
						);
					case "text":
					default:
						return (
							<Text key={idx} className="text-ink">
								{token.text}
							</Text>
						);
				}
			})}
		</>
	);
}

/**
 * High-performance mobile code card with copy button & horizontal scroll
 */
export const MobileCodeBlock = memo(function MobileCodeBlock({
	language,
	code,
}: {
	language: string;
	code: string;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await Clipboard.setStringAsync(code);
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	};

	const langLabel = (language || "CODE").toUpperCase();

	return (
		<View className="my-2.5 overflow-hidden rounded-xl border border-white/10 bg-[#121212]">
			<View className="flex-row items-center justify-between border-b border-white/5 bg-[#1c1c1e] px-3.5 py-2">
				<View className="flex-row items-center gap-2">
					<View className="h-2 w-2 rounded-full bg-accent/80" />
					<Text className="font-mono text-[11px] font-semibold tracking-wider text-ink-muted">
						{langLabel}
					</Text>
				</View>
				<Pressable
					onPress={handleCopy}
					hitSlop={8}
					className="flex-row items-center gap-1 rounded-md bg-white/5 px-2.5 py-1 active:bg-white/15"
				>
					<Text className="text-[11px] font-medium text-ink-muted">
						{copied ? "已复制" : "复制"}
					</Text>
				</Pressable>
			</View>
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				nestedScrollEnabled
				contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}
			>
				<Text className="font-mono text-[12px] leading-5 text-[#e5e5e5]" selectable>
					{code}
				</Text>
			</ScrollView>
		</View>
	);
});

/**
 * Mobile-optimized Table with horizontal scroll, distinct header, and bordered grid
 */
export const MobileTable = memo(function MobileTable({ block }: { block: TableBlock }) {
	return (
		<View className="my-3 overflow-hidden rounded-xl border border-white/10 bg-[#141416]">
			<ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
				<View className="min-w-full">
					{/* Table Header */}
					<View className="flex-row border-b border-white/10 bg-[#1c1c1f]">
						{block.header.map((cell, idx) => {
							const align = block.align[idx] ?? "left";
							const alignClass =
								align === "center"
									? "text-center"
									: align === "right"
										? "text-right"
										: "text-left";
							return (
								<View
									key={idx}
									className="min-w-[90px] max-w-[200px] border-r border-white/5 px-3.5 py-2.5 last:border-r-0"
								>
									<Text className={`font-semibold text-[12px] text-ink ${alignClass}`}>
										<RenderInline text={cell} />
									</Text>
								</View>
							);
						})}
					</View>

					{/* Table Rows */}
					{block.rows.map((row, rowIdx) => (
						<View
							key={rowIdx}
							className={`flex-row border-b border-white/5 last:border-b-0 ${
								rowIdx % 2 === 1 ? "bg-white/[0.02]" : ""
							}`}
						>
							{row.map((cell, cellIdx) => {
								const align = block.align[cellIdx] ?? "left";
								const alignClass =
									align === "center"
										? "text-center"
										: align === "right"
											? "text-right"
											: "text-left";
								return (
									<View
										key={cellIdx}
										className="min-w-[90px] max-w-[200px] border-r border-white/5 px-3.5 py-2 last:border-r-0"
									>
										<Text className={`text-[12px] leading-5 text-ink-muted ${alignClass}`}>
											<RenderInline text={cell} />
										</Text>
									</View>
								);
							})}
						</View>
					))}
				</View>
			</ScrollView>
		</View>
	);
});

/**
 * Mobile-rendered list with custom bullet or numeric pill
 */
export const MobileList = memo(function MobileList({ block }: { block: ListBlock }) {
	return (
		<View className="my-1.5 gap-1.5">
			{block.items.map((item, idx) => (
				<View key={idx} className="flex-row items-start pl-1">
					{block.ordered ? (
						<Text className="mr-2 font-mono text-[12px] leading-6 text-ink-muted">
							{idx + 1}.
						</Text>
					) : item.checked !== undefined ? (
						<Text className="mr-2 text-[13px] leading-6 text-accent">
							{item.checked ? "☑" : "☐"}
						</Text>
					) : (
						<Text className="mr-2 text-[14px] leading-6 text-ink-muted">•</Text>
					)}
					<Text className="flex-1 text-[14px] leading-6 text-ink">
						<RenderInline text={item.text} />
					</Text>
				</View>
			))}
		</View>
	);
});

/**
 * Comprehensive AST Markdown View for React Native
 */
export const MobileMarkdownView = memo(function MobileMarkdownView({
	content,
}: {
	content: string;
}) {
	const blocks = useMemo(() => parseBlocks(content), [content]);

	return (
		<View className="w-full gap-2">
			{blocks.map((block, idx) => {
				switch (block.kind) {
					case "heading": {
						const sizeClass =
							block.level === 1
								? "text-[18px] font-bold mt-3 mb-1"
								: block.level === 2
									? "text-[16px] font-bold mt-2.5 mb-1"
									: block.level === 3
										? "text-[14.5px] font-bold mt-2 mb-0.5"
										: "text-[13.5px] font-semibold mt-1 mb-0.5";
						return (
							<Text key={idx} className={`${sizeClass} text-ink`}>
								<RenderInline text={block.text} />
							</Text>
						);
					}

					case "table":
						return <MobileTable key={idx} block={block} />;

					case "code":
						return <MobileCodeBlock key={idx} language={block.lang} code={block.code} />;

					case "list":
						return <MobileList key={idx} block={block} />;

					case "rule":
						return <View key={idx} className="my-3 h-[1px] w-full bg-white/10" />;

					case "quote":
						return (
							<View
								key={idx}
								className="my-1.5 border-l-2 border-accent/60 bg-white/[0.03] px-3.5 py-2"
							>
								<Text className="italic text-[13px] leading-6 text-ink-muted">
									<RenderInline text={block.text} />
								</Text>
							</View>
						);

					case "paragraph":
					default: {
						const lines = block.text.split("\n");
						return (
							<View key={idx} className="gap-1">
								{lines.map((line, lIdx) => (
									<Text key={lIdx} className="text-[14px] leading-6 text-ink">
										<RenderInline text={line} />
									</Text>
								))}
							</View>
						);
					}
				}
			})}
		</View>
	);
});
