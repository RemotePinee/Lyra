import assert from "node:assert/strict";
import { test } from "node:test";
import { grepTool } from "../src/tools/grep.ts";
import { globTool } from "../src/tools/glob.ts";
import { readTool } from "../src/tools/read.ts";
import { symbolTool } from "../src/tools/symbol.ts";

test("grepTool accepts alias parameters such as query and search", async () => {
	const cwd = process.cwd();
	const res = await grepTool.execute({ query: "grepTool", path: cwd } as any, { cwd, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /grepTool/);
});

test("globTool accepts query and search aliases", async () => {
	const cwd = process.cwd();
	const res = await globTool.execute({ query: "**/tools/grep.ts", path: cwd } as any, { cwd, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /grep\.ts/);
});

test("readTool accepts file and filePath aliases", async () => {
	const cwd = process.cwd();
	const res = await readTool.execute({ file: "packages/core/src/tools/grep.ts", limit: 5 } as any, { cwd, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /1→import/);
});

test("symbolTool accepts query and symbol aliases", async () => {
	const cwd = process.cwd();
	const res = await symbolTool.execute({ query: "grepTool", path: cwd } as any, { cwd, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
});
