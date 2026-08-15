/**
 * The browser's tooltip stays out of this app.
 *
 * `title` on a DOM element draws a tooltip nobody here designed: a system panel with its own delay,
 * its own font and its own colours, which on macOS looks like it belongs to a different program.
 * The app has `data-ly-tip`, drawn by one document-level listener, so a stray `title` is not a
 * second style — it is a second tooltip that appears *beside* the first one on the same hover.
 *
 * They came back one at a time, in ones and twos, whenever a button was added. So this is a test
 * rather than a cleanup: the next one fails the suite instead of shipping.
 *
 * Component props named `title` are untouched — `<Section title="参数">` is a heading, not a tooltip,
 * which is why the check turns on the tag being an intrinsic element rather than on the name alone.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { tagAttributes } from "./jsx-attributes.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Tags where `title` is the element's own content or metadata, not a tooltip. */
const ALLOWED_TAGS = new Set(["title", "svg", "head", "iframe"]);

function* sources(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* sources(path);
		else if (/\.tsx?$/.test(path)) yield path;
	}
}

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

test("no DOM element carries a native title attribute", () => {
	const offenders: string[] = [];

	for (const path of sources(SRC)) {
		const source = readFileSync(path, "utf8");
		for (const attribute of tagAttributes(source)) {
			if (attribute.name !== "title") continue;
			// Intrinsic elements are lowercase; components are capitalised.
			if (attribute.tag[0] !== attribute.tag[0].toLowerCase()) continue;
			if (ALLOWED_TAGS.has(attribute.tag)) continue;
			offenders.push(`${relative(SRC, path)}:${lineOf(source, attribute.index)} <${attribute.tag}>`);
		}
	}

	assert.deepEqual(offenders, [], `use data-ly-tip instead of title:\n${offenders.join("\n")}`);
});

test("an attribute after an arrow-function handler is still seen", () => {
	// The bug this guards: walking backwards from `title=` stops at the `>` of `=>`.
	const source = `<button onClick={() => close()} title="关闭" />`;
	const names = tagAttributes(source).map((a) => a.name);
	assert.deepEqual(names, ["onClick", "title"]);
});

test("a title prop on a component is not a native title", () => {
	const source = `<Section title="参数" mono />`;
	const [attribute] = tagAttributes(source);
	assert.equal(attribute.tag, "Section");
	assert.equal(attribute.tag[0], "S");
});

test("a quoted angle bracket does not end the tag", () => {
	const source = `<span data-x="a>b" title="真的" />`;
	assert.deepEqual(tagAttributes(source).map((a) => a.name), ["data-x", "title"]);
});
