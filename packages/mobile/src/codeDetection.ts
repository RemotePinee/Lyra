/**
 * Heuristics to detect stack traces, terminal errors, logs, or multi-line code blocks
 * instead of arbitrary plain conversation text for mobile and shared parsing.
 */

// Error / Stack trace signatures
const STACK_OR_LOG_PATTERNS = [
	/^\s*at\s+(?:async\s+)?[\w$.<>]+\s+\(.*:\d+(?::\d+)?\)/m, // V8 / Node stack: at foo (file.js:1:2)
	/^\s*at\s+.*:\d+(?::\d+)?$/m, // Node stack: at file.js:1:2
	/^\s*(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|UnhandledPromiseRejection):/m, // JS Errors
	/^\s*(?:Traceback \(most recent call last\):|File ".*", line \d+)/m, // Python tracebacks
	/^\s*(?:panic:|fatal error:|goroutine \d+ \[)/m, // Go panics
	/^\s*(?:Exception in thread|java\.\w+\.\w+Exception|at [a-zA-Z0-9_$.]+\([A-Za-z0-9_$]+\.java:\d+\))/m, // Java exceptions
	/^\s*(?:error\[E\d+\]:|thread '.*' panicked at)/m, // Rust compiler / panics
	/^\s*(?:npm ERR!|yarn error|pnpm: |\[ERR_\w+\]|\[ELIFECYCLE\])/m, // Node package manager errors
	/^\s*(?:webpack|vite|rollup|turbo|next|expo|metro).*error/im, // Build tool errors
	/^[A-Z][a-zA-Z0-9_]*Error: /m, // Generic PascalCase Errors
	/^(?:FATAL|ERROR|WARN|INFO|DEBUG|TRACE)[\s:[]/m, // Standard log levels
	/(?:\/[a-zA-Z0-9_.-]+){3,}:\d+:\d+/, // Unix paths with line:col
	/(?:[A-Za-z]:\\[a-zA-Z0-9_.\-\\]+){2,}:\d+(?::\d+)?/, // Windows paths with line:col
];

// Code structure signatures (syntax markers)
const CODE_PATTERNS = [
	/(?:const|let|var|function|import|export|class|interface|type|enum|return|if|for|while|switch)\s+[\w${]/m,
	/(?:def|class|import|from|return|if __name__ == ['"]__main__['"])\s*[:\w]/m,
	/(?:public|private|protected|static|final|fn|impl|pub|func|package|struct)\s+[\w<]/m,
	/[{};()=>]{4,}/, // High density of syntax punctuation
	/<(?:div|span|button|View|Text|Pressable|Modal|p|h[1-6]|ul|li|template|Component)\b[^>]*>/, // JSX / HTML tags
	/^\s*[{[][\s\S]*[}\]]\s*$/, // JSON payload
	/^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+.*FROM\s+/im, // SQL query
];

export interface CodeOrErrorMatch {
	isMatch: boolean;
	kind: "stack_trace" | "error_log" | "code" | "text";
	suggestedName: string;
}

export function detectCodeOrError(text: string): CodeOrErrorMatch {
	const trimmed = text.trim();
	const lines = trimmed.split("\n");

	// A single short line is normal conversation / mention, not a whole pasted log/code file
	if (lines.length < 3 && trimmed.length < 150) {
		return { isMatch: false, kind: "text", suggestedName: "text.txt" };
	}

	// 1. Check for stack trace or error log
	for (const pattern of STACK_OR_LOG_PATTERNS) {
		if (pattern.test(trimmed)) {
			let name = "error-log.txt";
			if (trimmed.includes("Traceback") || trimmed.includes("File \"")) name = "traceback.txt";
			else if (trimmed.includes("panic:")) name = "panic.txt";
			else if (/at\s+(?:async\s+)?[\w$.<>]+\s+\(/.test(trimmed)) name = "stack-trace.txt";
			return { isMatch: true, kind: "stack_trace", suggestedName: name };
		}
	}

	// 2. Check for code blocks
	let codeScore = 0;
	for (const pattern of CODE_PATTERNS) {
		if (pattern.test(trimmed)) {
			codeScore++;
		}
	}

	// Require either strong code syntax markers or JSON
	if (codeScore >= 2 || (codeScore >= 1 && lines.length >= 5)) {
		let name = "code-snippet.txt";
		if (trimmed.includes("import React") || trimmed.includes("className=") || /<[A-Z]\w+/.test(trimmed)) {
			name = "component.tsx";
		} else if (/^\s*[{[]/.test(trimmed) && /[}\]]\s*$/.test(trimmed)) {
			name = "payload.json";
		} else if (trimmed.includes("def ") || trimmed.includes("import numpy") || trimmed.includes("import pandas")) {
			name = "script.py";
		}
		return { isMatch: true, kind: "code", suggestedName: name };
	}

	// 3. Fallback for large raw text dumps (>= 20 lines or >= 1200 characters)
	if (lines.length >= 20 || trimmed.length >= 1200) {
		return { isMatch: true, kind: "text", suggestedName: "pasted-text.txt" };
	}

	return { isMatch: false, kind: "text", suggestedName: "text.txt" };
}

export interface ParsedUserPart {
	type: "text" | "attachment";
	content: string;
	title?: string;
	language?: string;
}

/**
 * Parses user message content to extract both explicit attachment blocks
 * (e.g. `### 附件文件: filename.txt\n```...```) and raw pasted error/code sections.
 */
export function parseUserMessageContent(rawText: string): ParsedUserPart[] {
	const trimmed = rawText.trim();
	if (!trimmed) return [];

	const parts: ParsedUserPart[] = [];

	// Check for markdown attachment block: ### 附件文件: xxx.txt\n```lang\n...\n```
	const attachmentRegex = /### 附件文件: ([^\n]+)\n```([^\n]*)\n([\s\S]*?)```/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = attachmentRegex.exec(trimmed)) !== null) {
		if (match.index > lastIndex) {
			const prompt = trimmed.slice(lastIndex, match.index).trim();
			if (prompt) {
				parts.push({ type: "text", content: prompt });
			}
		}
		const title = match[1].trim();
		const language = match[2].trim() || undefined;
		const content = match[3];
		parts.push({ type: "attachment", content, title, language });
		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < trimmed.length) {
		const remaining = trimmed.slice(lastIndex).trim();
		if (remaining) {
			// If not matched as explicit attachment block, test if the remaining block itself is raw code/stack trace
			const detected = detectCodeOrError(remaining);
			if (detected.isMatch) {
				parts.push({
					type: "attachment",
					content: remaining,
					title: detected.suggestedName,
				});
			} else {
				parts.push({ type: "text", content: remaining });
			}
		}
	}

	return parts.length > 0 ? parts : [{ type: "text", content: trimmed }];
}
