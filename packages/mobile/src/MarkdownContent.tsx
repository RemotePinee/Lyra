import * as Clipboard from "expo-clipboard";
import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

interface CodeBlockPart {
	type: "code";
	language: string;
	code: string;
}

interface TextPart {
	type: "text";
	text: string;
}

type MarkdownPart = CodeBlockPart | TextPart;

export function parseMarkdownParts(raw: string): MarkdownPart[] {
	const parts: MarkdownPart[] = [];
	const codeBlockRegex = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = codeBlockRegex.exec(raw)) !== null) {
		if (match.index > lastIndex) {
			const text = raw.slice(lastIndex, match.index);
			if (text.length > 0) {
				parts.push({ type: "text", text });
			}
		}
		parts.push({
			type: "code",
			language: match[1] || "",
			code: match[2].replace(/\n$/, ""),
		});
		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < raw.length) {
		const remaining = raw.slice(lastIndex);
		if (remaining.length > 0) {
			parts.push({ type: "text", text: remaining });
		}
	}

	return parts;
}

export function MobileCodeBlock({ language, code }: { language: string; code: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await Clipboard.setStringAsync(code);
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	};

	const langLabel = (language || "CODE").toUpperCase();

	return (
		<View className="my-2.5 overflow-hidden rounded-xl border border-white/10 bg-[#121212]">
			{/* Code Block Header */}
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

			{/* Code Block Content with horizontal scroll */}
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				nestedScrollEnabled
				contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}
			>
				<Text
					className="font-mono text-[12px] leading-5 text-[#e5e5e5]"
					selectable
				>
					{code}
				</Text>
			</ScrollView>
		</View>
	);
}

/**
 * Parses inline formatting like `inline code` and **bold**.
 */
function renderInlineText(rawText: string, keyPrefix: string) {
	// Match inline code `code` or bold **bold**
	const inlineRegex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
	const parts = rawText.split(inlineRegex);

	return parts.map((seg, i) => {
		const key = `${keyPrefix}-${i}`;
		if (seg.startsWith("`") && seg.endsWith("`") && seg.length >= 2) {
			const codeContent = seg.slice(1, -1);
			return (
				<Text
					key={key}
					className="rounded bg-card/80 px-1.5 py-0.5 font-mono text-[12.5px] text-[#ff9f43]"
				>
					{codeContent}
				</Text>
			);
		}
		if (seg.startsWith("**") && seg.endsWith("**") && seg.length >= 4) {
			const boldContent = seg.slice(2, -2);
			return (
				<Text key={key} className="font-bold text-ink">
					{boldContent}
				</Text>
			);
		}
		return (
			<Text key={key} className="text-ink">
				{seg}
			</Text>
		);
	});
}

/**
 * Formats paragraphs, lists, and headers in non-code text blocks.
 */
export function MobileMarkdownText({ text }: { text: string }) {
	const lines = text.split("\n");

	return (
		<View className="gap-1">
			{lines.map((line, idx) => {
				const trimmed = line.trim();
				if (!trimmed) {
					return <View key={idx} className="h-1.5" />;
				}

				// Heading ###
				if (/^#{1,4}\s+/.test(trimmed)) {
					const headingText = trimmed.replace(/^#{1,4}\s+/, "");
					return (
						<Text key={idx} className="mt-1 font-bold text-[14.5px] leading-6 text-ink">
							{renderInlineText(headingText, `h-${idx}`)}
						</Text>
					);
				}

				// Bullet list • / - / *
				if (/^[-*+]\s+/.test(trimmed)) {
					const itemText = trimmed.replace(/^[-*+]\s+/, "");
					return (
						<View key={idx} className="flex-row items-start pl-1">
							<Text className="mr-2 text-[14px] leading-6 text-ink-muted">•</Text>
							<Text className="flex-1 text-[14px] leading-6 text-ink">
								{renderInlineText(itemText, `li-${idx}`)}
							</Text>
						</View>
					);
				}

				// Standard paragraph text
				return (
					<Text key={idx} className="text-[14px] leading-6 text-ink">
						{renderInlineText(line, `p-${idx}`)}
					</Text>
				);
			})}
		</View>
	);
}

/**
 * Complete Markdown viewer supporting structured code blocks and formatted text.
 */
export function MobileMarkdownView({ content }: { content: string }) {
	const parts = parseMarkdownParts(content);

	return (
		<View className="w-full">
			{parts.map((part, idx) => {
				if (part.type === "code") {
					return <MobileCodeBlock key={idx} language={part.language} code={part.code} />;
				}
				return <MobileMarkdownText key={idx} text={part.text} />;
			})}
		</View>
	);
}
