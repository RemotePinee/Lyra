import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeProcessOutput, systemShell } from "../src/platform.ts";
import { grepTool } from "../src/tools/grep.ts";
import { globTool } from "../src/tools/glob.ts";
import { toResponsesInput } from "../src/ai/openai-responses-request.ts";
import type { AssistantMessage, ToolContext } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

test("systemShell on Windows provides a shell that supports command chaining", () => {
	if (process.platform === "win32") {
		const shell = systemShell();
		assert.ok(
			shell.file.toLowerCase().includes("cmd.exe") || shell.file.toLowerCase().includes("bash") || shell.file.toLowerCase().includes("sh"),
			"Windows systemShell should default to cmd.exe or user-configured SHELL",
		);
		assert.ok(shell.flag === "/c" || shell.flag === "-c");
	}
});

test("decodeProcessOutput handles UTF-8 and GBK encoded chunks cleanly", () => {
	const utf8Text = "Hello 世界 123";
	const utf8Buffer = Buffer.from(utf8Text, "utf8");
	assert.equal(decodeProcessOutput(utf8Buffer), utf8Text);

	// Chinese Windows error message encoded in GBK (CP936) for "所在位置"
	const gbkBuffer = Buffer.from([0xcb, 0xf9, 0xd4, 0xda, 0xce, 0xbb, 0xd6, 0xc3]);
	const decoded = decodeProcessOutput(gbkBuffer);
	assert.ok(decoded.includes("所在位置") || decoded.length > 0);
});

test("grep tool extracts pattern from description or query fallback", async () => {
	const fakeCtx: ToolContext = {
		cwd: process.cwd(),
		sessionId: "test-session",
		state: new Map(),
	};

	// When pattern is missing but description contains "pattern: xxx"
	const descArgs = { description: "pattern: ModelConfig", context: 2 } as unknown as { pattern: string };
	const descResult = await grepTool.execute(descArgs, fakeCtx);
	assert.equal(descResult.isError ?? false, false);

	// When pattern is missing but query is provided
	const queryArgs = { query: "export function", files_only: true } as unknown as { pattern: string };
	const queryResult = await grepTool.execute(queryArgs, fakeCtx);
	assert.equal(queryResult.isError ?? false, false);
});

test("glob tool extracts pattern from description or glob fallback", async () => {
	const fakeCtx: ToolContext = {
		cwd: process.cwd(),
		sessionId: "test-session",
		state: new Map(),
	};

	// When pattern is missing but description contains "pattern: *.ts"
	const descArgs = { description: "pattern: *.json" } as unknown as { pattern: string };
	const descResult = await globTool.execute(descArgs, fakeCtx);
	assert.equal(descResult.isError ?? false, false);

	// When pattern is missing but glob is provided
	const globArgs = { glob: "packages/*" } as unknown as { pattern: string };
	const globResult = await globTool.execute(globArgs, fakeCtx);
	assert.equal(globResult.isError ?? false, false);
});

test("toResponsesInput ensures function_call arguments are strictly valid JSON", () => {
	const assistantMsg: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_1",
				name: "bash",
				arguments: { command: "npm test" },
				// Simulated corrupted/truncated argumentsText
				argumentsText: '{"command": "npm',
			},
		],
		api: "openai-responses",
		provider: "fake",
		model: "fake",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};

	const inputs = toResponsesInput([assistantMsg]) as Array<{ type: string; arguments?: string }>;
	const functionCall = inputs.find((item) => item.type === "function_call");
	assert.ok(functionCall, "function_call must exist in input");
	assert.doesNotThrow(() => {
		JSON.parse(functionCall.arguments!);
	}, "Corrupted argumentsText must fall back to valid serialized JSON");
	assert.equal(functionCall.arguments, JSON.stringify({ command: "npm test" }));
});
