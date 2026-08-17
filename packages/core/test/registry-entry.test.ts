/**
 * What an index is allowed to say.
 *
 * This is a contract with people who do not have this codebase — anyone publishing a registry — so
 * it is checked here rather than only when a fetch happens to run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalise } from "../src/plugins/registry.ts";

const base = { id: "x", name: "X", repository: "https://github.com/o/r.git" };

test("a plugin entry survives intact, logo and all", () => {
	const entry = normalise({ ...base, kind: "plugin", logo: "https://github.com/o.png?size=128" });
	assert.equal(entry?.kind, "plugin");
	assert.equal(entry?.logo, "https://github.com/o.png?size=128");
});

test("kind is taken from the index when stated", () => {
	assert.equal(normalise({ ...base, kind: "mcp" })?.kind, "mcp");
	assert.equal(normalise({ ...base, kind: "skill" })?.kind, "skill");
	assert.equal(normalise({ ...base, kind: "plugin" })?.kind, "plugin");
});

test("and inferred only when it is not", () => {
	// Naming an npm package is how an MCP server is distributed; nothing else in the format implies one.
	assert.equal(normalise({ ...base, package: "@scope/thing" })?.kind, "mcp");
	assert.equal(normalise(base)?.kind, "plugin");
	// A skill collection is never guessed at — it has no distinguishing field.
	assert.notEqual(normalise(base)?.kind, "skill");
});

test("nonsense in `kind` falls back to the inference rather than through", () => {
	assert.equal(normalise({ ...base, kind: "banana" })?.kind, "plugin");
	assert.equal(normalise({ ...base, kind: "banana", package: "p" })?.kind, "mcp");
});

test("a sub-path is kept, which is how one repository ships many bundles", () => {
	assert.equal(normalise({ ...base, path: "skills" })?.path, "skills");
	assert.equal(normalise(base)?.path, undefined);
});

test("a missing id is derived from the name rather than rejected", () => {
	// An index that named the thing has said enough; requiring both would reject entries for a
	// field the publisher had no reason to think mattered.
	assert.equal(normalise({ name: "Agent Browser", repository: "https://github.com/o/r.git" })?.id, "agent-browser");
});

test("an entry with nowhere to clone from is dropped", () => {
	assert.equal(normalise({ id: "x", name: "X" }), null, "no repository");
	assert.equal(normalise({ ...base, repository: "ftp://example.com/x" }), null, "not a git scheme");
	assert.equal(normalise(null), null);
	assert.equal(normalise("a string"), null);
});
