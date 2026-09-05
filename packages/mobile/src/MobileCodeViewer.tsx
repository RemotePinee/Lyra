import React, { memo, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useThemeColors } from "./theme";

export interface CodeHighlightProps {
	code: string;
	fileName?: string;
}

// Lightweight syntax tokenizer for React Native (IDE-like coloring)
interface Token {
	text: string;
	color: string;
	bold?: boolean;
}

const KEYWORDS = new Set([
	"import", "export", "from", "default", "const", "let", "var", "function", "return",
	"if", "else", "switch", "case", "break", "continue", "for", "while", "do",
	"class", "interface", "type", "extends", "implements", "public", "private", "protected",
	"async", "await", "try", "catch", "finally", "throw", "new", "typeof", "instanceof",
	"as", "in", "of", "null", "undefined", "true", "false", "this", "super",
	"package", "func", "def", "struct", "enum", "impl", "trait", "mut", "fn"
]);

const TYPES = new Set([
	"string", "number", "boolean", "any", "void", "never", "unknown", "object",
	"Promise", "Array", "Record", "Map", "Set", "Date", "Error", "RegExp"
]);

function tokenizeLine(line: string, isDark: boolean): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const len = line.length;

	const colors = isDark
		? {
				comment: "#6a737d",
				string: "#9ecbff",
				number: "#79b8ff",
				keyword: "#f97583",
				type: "#b392f0",
				fn: "#ffab70",
				text: "#e1e4e8",
				punct: "#8b949e",
			}
		: {
				comment: "#6a737d",
				string: "#032f62",
				number: "#005cc5",
				keyword: "#d73a49",
				type: "#6f42c1",
				fn: "#e36209",
				text: "#24292e",
				punct: "#586069",
			};

	while (i < len) {
		// Single-line comments: // or #
		if (line.slice(i, i + 2) === "//" || line[i] === "#") {
			tokens.push({ text: line.slice(i), color: colors.comment });
			break;
		}

		// Strings: "...", '...', `...`
		if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
			const quote = line[i];
			let j = i + 1;
			while (j < len && line[j] !== quote) {
				if (line[j] === "\\" && j + 1 < len) j++;
				j++;
			}
			if (j < len) j++; // Include closing quote
			tokens.push({ text: line.slice(i, j), color: colors.string });
			i = j;
			continue;
		}

		// Numbers: 123, 0x1a, 3.14
		if (/\d/.test(line[i])) {
			let j = i;
			while (j < len && /[\d.a-fA-FxX_]/.test(line[j])) j++;
			tokens.push({ text: line.slice(i, j), color: colors.number });
			i = j;
			continue;
		}

		// Words: identifiers, keywords, types
		if (/[a-zA-Z_$]/.test(line[i])) {
			let j = i;
			while (j < len && /[a-zA-Z0-9_$]/.test(line[j])) j++;
			const word = line.slice(i, j);

			if (KEYWORDS.has(word)) {
				tokens.push({ text: word, color: colors.keyword, bold: true });
			} else if (TYPES.has(word) || /^[A-Z][a-zA-Z0-9]*$/.test(word)) {
				tokens.push({ text: word, color: colors.type });
			} else if (j < len && line[j] === "(") {
				tokens.push({ text: word, color: colors.fn });
			} else {
				tokens.push({ text: word, color: colors.text });
			}
			i = j;
			continue;
		}

		// Punctuation and symbols
		const char = line[i];
		if (/[{}()[\].,;:?!=+\-*/%&|^~<>]/.test(char)) {
			tokens.push({ text: char, color: colors.text });
		} else {
			tokens.push({ text: char, color: colors.punct });
		}
		i++;
	}

	return tokens;
}

const MAX_LINES = 80;

export const MobileCodeViewer = memo(function MobileCodeViewer({
	code,
}: CodeHighlightProps) {
	const { isDark } = useThemeColors();

	const allLines = useMemo(() => code.split("\n"), [code]);
	const displayLines = useMemo(() => allLines.slice(0, MAX_LINES), [allLines]);
	const hasMore = allLines.length > MAX_LINES;

	// Pre-tokenize once; avoid re-running regex on every render
	const tokenizedLines = useMemo(
		() => displayLines.map((line) => tokenizeLine(line, isDark)),
		[displayLines, isDark],
	);

	return (
		<ScrollView
			horizontal
			nestedScrollEnabled
			showsHorizontalScrollIndicator
			directionalLockEnabled
			contentContainerStyle={{ minWidth: "100%", paddingVertical: 10, paddingRight: 16 }}
		>
			<View className="flex-col">
				{tokenizedLines.map((tokens, idx) => {
					const lineNum = idx + 1;

					return (
						<View key={idx} className="flex-row items-center leading-6">
							{/* Line number gutter (IDE style) */}
							<Text className={`w-10 pr-3 text-right font-mono text-[11px] select-none ${isDark ? "text-[#545d68]" : "text-[#959da5]"}`}>
								{lineNum}
							</Text>
							{/* Code tokens */}
							<Text className={`font-mono text-[12px] leading-5 select-text ${isDark ? "text-[#e1e4e8]" : "text-[#24292e]"}`}>
								{tokens.map((token, tIdx) => (
									<Text
										key={tIdx}
										style={{
											color: token.color,
											fontWeight: token.bold ? "600" : "normal",
										}}
									>
										{token.text}
									</Text>
								))}
							</Text>
						</View>
					);
				})}
				{hasMore && (
					<View className="py-2 pl-10">
						<Text className="font-mono text-[11px] text-ink-faint">
							… 剩余 {allLines.length - MAX_LINES} 行已省略
						</Text>
					</View>
				)}
			</View>
		</ScrollView>
	);
});
