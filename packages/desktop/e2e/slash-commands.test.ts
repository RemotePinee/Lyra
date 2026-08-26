/**
 * Typing a slash, in the real window.
 *
 * Everything here is about the composer's behaviour under the keyboard, which is the half of this
 * feature that cannot be checked any other way: the loader has unit tests, but "does the list open,
 * filter, move under the arrow keys, and put the right text in the field" is a claim about a
 * textarea, a floating panel and their event handling together.
 *
 * The command files are written into the profile before launch — one under `.lyra`, one under
 * `.claude` — because the compatibility claim is worth holding to the same standard as the rest:
 * a file somebody wrote for Claude Code has to show up here without being touched.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";

let app: RunningApp;
let project: string;

async function seed(home: string): Promise<void> {
	project = join(home, "project");
	await mkdir(project, { recursive: true });

	// Ours, at user level.
	await mkdir(join(home, "commands"), { recursive: true });
	await writeFile(
		join(home, "commands", "review-diff.md"),
		"---\ndescription: 审查当前改动\nargument-hint: <路径>\n---\n\n请审查 $ARGUMENTS 的改动。",
	);

	// A project-level one, in a directory that belongs to another program entirely.
	await mkdir(join(project, ".claude", "commands"), { recursive: true });
	await writeFile(join(project, ".claude", "commands", "ship-it.md"), "---\ndescription: 发布检查\n---\n跑一遍发布前检查。");

	// And a namespaced one, to prove the directory becomes part of the name.
	await mkdir(join(home, "commands", "git"), { recursive: true });
	await writeFile(join(home, "commands", "git", "sync.md"), "---\ndescription: 同步远端\n---\n拉取并变基。");

	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: null,
			permissionMode: "full",
			thinking: "off",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			sync: { enabled: false, port: 4525, token: null },
			appearance: { theme: "dark" },
		}),
	);
}

before(async () => {
	app = await startApp({ port: 9473, seed });
	await new Promise((r) => setTimeout(r, 800));
});

after(async () => {
	await app?.stop();
});

/** Type into the composer the way a person does: set the value, then fire what React listens for. */
async function type(text: string): Promise<void> {
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, ${JSON.stringify(text)});
		field.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	})()`);
	await new Promise((r) => setTimeout(r, 350));
}

/** One key, on the field itself, so the composer's own handler decides what it means. */
async function press(key: string): Promise<void> {
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		field.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
		return true;
	})()`);
	await new Promise((r) => setTimeout(r, 250));
}

const menu = () => app.evaluate<string[]>(`
	Array.from(document.querySelectorAll('[role="option"]')).map((row) => row.textContent ?? "")
`);

const value = () => app.evaluate<string>(`document.querySelector("main textarea")?.value ?? ""`);

/** The line at the foot of the list, which describes whichever row is highlighted. */
const detail = () =>
	app.evaluate<string>(`document.querySelector("[data-ly-command-detail]")?.textContent ?? ""`);

test("a slash opens the list, and it holds commands from both conventions", async () => {
	await type("/");
	const rows = await menu();

	assert.ok(rows.length > 0, "the list opened");
	assert.ok(rows.some((row) => row.includes("review-diff")), `ours is there (${rows.join(" | ")})`);
	assert.ok(
		rows.some((row) => row.includes("ship-it")),
		"and so is the one written for Claude Code, untouched",
	);
	assert.ok(rows.some((row) => row.includes("git:sync")), "a nested file is namespaced by its directory");
	assert.ok(rows.some((row) => row.includes("compact")), "the built-ins are in the same list");
});

test("typing filters, and reaches into the middle of a name", async () => {
	await type("/diff");
	const rows = await menu();
	assert.equal(rows.length, 1, `only one command contains "diff" (${rows.join(" | ")})`);
	assert.ok(rows[0].includes("review-diff"));
	assert.ok(rows[0].includes("<路径>"), "the argument hint rides along with the name");

	/*
	 * The description lives at the foot of the list rather than on the row.
	 *
	 * A row carrying a name, a hint, a description and a source stops being scannable — and a
	 * tooltip would not be available to somebody moving through the list on the arrow keys, which
	 * is when the description is actually wanted.
	 */
	assert.match(await detail(), /审查当前改动/, "and the description is below, for whichever row is current");
});

test("the description follows the highlight", async () => {
	await type("/c");
	const before = await detail();
	await press("ArrowDown");
	const after = await detail();
	assert.notEqual(before, after, `moving the highlight changes the line below (${before} → ${after})`);
});

test("a namespaced command is reachable by its last segment", async () => {
	await type("/sync");
	const rows = await menu();
	assert.ok(
		rows.some((row) => row.includes("git:sync")),
		`typing the segment finds it (${rows.join(" | ")})`,
	);
});

test("Enter picks the highlighted command instead of sending the message", async () => {
	await type("/diff");
	await press("Enter");

	assert.equal(await value(), "/review-diff ", "the name is in the field, with room for arguments");
	assert.deepEqual(await menu(), [], "and the list is closed, because the name is settled");
});

test("the arrow keys move the highlight", async () => {
	await type("/");
	const rows = await menu();
	assert.ok(rows.length >= 2, "enough to move between");

	const first = await app.evaluate<number>(
		`Array.from(document.querySelectorAll('[role="option"]')).findIndex((r) => r.getAttribute("aria-selected") === "true")`,
	);
	await press("ArrowDown");
	const second = await app.evaluate<number>(
		`Array.from(document.querySelectorAll('[role="option"]')).findIndex((r) => r.getAttribute("aria-selected") === "true")`,
	);
	assert.equal(first, 0, "it starts at the top");
	assert.equal(second, 1, "and Down moves it");
});

test("Escape closes the list without touching what was typed", async () => {
	await type("/rev");
	assert.ok((await menu()).length > 0, "open");

	await press("Escape");
	assert.deepEqual(await menu(), [], "closed");
	assert.equal(await value(), "/rev", "and the text is still there — a slash is also how paths start");
});

test("a slash that is not at the start is ordinary text", async () => {
	/*
	 * The composer is mostly used for prose, and prose contains paths and fractions. A list that
	 * opened on any slash would be in the way far more often than it helped.
	 */
	await type("看看 src/main.ts");
	assert.deepEqual(await menu(), [], "no list for a path");

	await type("/");
	assert.ok((await menu()).length > 0, "but a leading one still opens it");
	await type("");
});
