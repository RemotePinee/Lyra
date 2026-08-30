/**
 * Heuristics to detect stack traces, terminal errors, logs, or multi-line code blocks
 * instead of arbitrary plain conversation text.
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
		if (/<(?:div|span|button|View|Text|Pressable|Modal)\b/.test(trimmed)) name = "component.tsx";
		else if (/^\s*[{[][\s\S]*[}\]]\s*$/.test(trimmed)) name = "data.json";
		else if (/(?:function|const|let|var|export|import)\b/.test(trimmed)) name = "snippet.ts";
		else if (/(?:def |import |class |print\()/.test(trimmed)) name = "script.py";
		return { isMatch: true, kind: "code", suggestedName: name };
	}

	return { isMatch: false, kind: "text", suggestedName: "pasted-text.txt" };
}

/**
 * Splits user input that may contain surrounding comments + a large code/error block.
 * For example:
 * "运行 pnpm dev 报错了：
 * Error: ...
 * at ...
 * 怎么解决？"
 *
 * returns prompt text + extracted error/code block.
 */
export function extractCodeOrErrorBlocks(text: string): {
	hasExtracted: boolean;
	mainText: string;
	extractedBlock?: { name: string; content: string; kind: string };
} {
	const trimmed = text.trim();

	// Check if the text as a whole contains error logs, stack traces, or code
	const match = detectCodeOrError(trimmed);
	if (match.isMatch) {
		return {
			hasExtracted: true,
			mainText: "",
			extractedBlock: {
				name: match.suggestedName,
				content: trimmed,
				kind: match.kind,
			},
		};
	}

	return { hasExtracted: false, mainText: text };
}
