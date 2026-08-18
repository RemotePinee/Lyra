/**
 * Changing files, in the app that will actually be shipped.
 *
 * The unit tests cover the rules — what a legal name is, which paths are inside a project. What
 * they cannot cover is the part that only exists once there is a main process: whether the handler
 * is registered, whether the preload forwards it, and whether the bytes on disk afterwards are what
 * the panel claimed. Every assertion here reads the real filesystem rather than the tree's idea of
 * it, because the tree's idea of it is the thing most likely to be wrong.
 *
 * The layout check at the end belongs with these for one reason: it is the other half of the same
 * complaint. A filter that stretches across a panel it does not filter is a claim about scope, and
 * a claim about scope is worth a regression test.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";

let app: RunningApp;
let project: string;

/** Written into the profile before launch, so the app opens with a project already known. */
async function seed(home: string): Promise<void> {
	const root = join(home, "project");
	await mkdir(join(root, "src", "deep"), { recursive: true });
	await mkdir(join(root, "docs"), { recursive: true });
	await writeFile(join(root, "src", "main.ts"), "export const a = 1\n");
	await writeFile(join(root, "src", "deep", "inner.txt"), "nested\n");
	await writeFile(join(root, "docs", "notes.md"), "# notes\n");
	/*
	 * A window wide enough for the panel to have two columns in it.
	 *
	 * The default is 980, where a full-screen panel is still under the width at which the tree and
	 * the file sit side by side — so the layout claim below would be tested against the stacked
	 * arrangement, which is not the arrangement it is about. `window.json` is read at launch.
	 */
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: root, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			sync: { enabled: false, port: 4517, token: null },
		}),
	);
}

before(async () => {
	app = await startApp({ port: 9445, seed });
	project = join(app.home, "project");
});

after(async () => {
	await app?.stop();
});

/** Run an expression with the project's path already in scope, since every one of them needs it. */
function inProject<T>(body: string): Promise<T> {
	return app.evaluate<T>(`(async () => { const P = ${JSON.stringify(project)}; ${body} })()`);
}

/**
 * The gestures, as the person using the app makes them.
 *
 * Injected before every UI expression rather than repeated in each: right-clicking a row and
 * picking an item off the menu is four lines of DOM every time, and four lines repeated eight
 * times is where a test suite starts disagreeing with itself about what "click 删除" means.
 *
 * `label` normalises whitespace because a menu row renders its text and its shortcut as separate
 * blocks — `innerText` puts a newline between them, and matching on "复制 " then never matches.
 */
const UI = `
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const label = (el) => el.innerText.replace(/\\s+/g, " ").trim();
	const rows = () => [...document.querySelectorAll("[role=treeitem]")];
	const row = (suffix) => rows().find((r) => r.getAttribute("data-path").endsWith(suffix));
	const item = (text) => [...document.querySelectorAll("[role=menuitem]")].find((i) => label(i).startsWith(text));
	const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	const openMenu = (el) => {
		const b = el.getBoundingClientRect();
		el.dispatchEvent(new MouseEvent("contextmenu", {
			bubbles: true, cancelable: true, button: 2,
			clientX: Math.round(b.left + 40), clientY: Math.round(b.top + 8),
		}));
	};
	const type = (input, text) => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setter.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	};
	const key = (init) => document.querySelector("[data-ly-tree]").dispatchEvent(
		new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
	);
	const confirm = (verb) => [...document.querySelectorAll("[role=dialog] button")].find((b) => label(b) === verb)?.click();
	const toasts = () => [...document.querySelectorAll("[role=alert], [role=status]")];
`;

/** Drive the window with `UI` in scope. Everything here is an `await`-able page turn. */
function ui<T>(body: string): Promise<T> {
	return app.evaluate<T>(`(async () => { ${UI} const P = ${JSON.stringify(project)}; ${body} })()`);
}

/** Open the panel on the files tab, with the project's own tree showing. */
async function openFilePanel(): Promise<void> {
	await ui(`
		const tab = [...document.querySelectorAll("button")].find((b) => b.innerText.trim().startsWith("文件"));
		if (!document.querySelector("[data-ly-tree]")) { tab?.click(); await wait(500); }
		if (!row("/src")) await wait(500);
		if (!row("src/main.ts")) { click(row("/src")); await wait(500); }
	`);
}

test("a file is created, and it is on disk", async () => {
	const result = await inProject<{ ok: boolean; path?: string }>(
		`return window.lyra.files.create(P + "/src", "made.ts", "file")`,
	);
	assert.equal(result.ok, true, result.path ?? "create failed");
	assert.equal(await readFile(join(project, "src", "made.ts"), "utf8"), "");
});

test("the same name twice is refused as a question, not as an error", async () => {
	const again = await inProject<{ ok: boolean; code?: string }>(
		`return window.lyra.files.create(P + "/src", "made.ts", "file")`,
	);
	assert.equal(again.ok, false);
	// `exists` is what the panel keys its replace prompt off; any other code and it would give up.
	assert.equal(again.code, "exists");
});

test("renaming moves the bytes and leaves nothing behind", async () => {
	const result = await inProject<{ ok: boolean }>(
		`return window.lyra.files.rename(P + "/src/made.ts", P + "/docs/renamed.ts")`,
	);
	assert.equal(result.ok, true);
	assert.ok(!(await readdir(join(project, "src"))).includes("made.ts"), "the source is gone");
	assert.ok((await readdir(join(project, "docs"))).includes("renamed.ts"), "and the target is there");
});

test("a copy keeps both, and a free name is found for the second", async () => {
	const free = await inProject<{ ok: boolean; path?: string }>(
		`return window.lyra.files.uniquePath(P + "/src", "main.ts")`,
	);
	assert.equal(free.path, join(project, "src", "main copy.ts"));

	const copied = await inProject<{ ok: boolean }>(
		`return window.lyra.files.copy(P + "/src/main.ts", P + "/src/main copy.ts")`,
	);
	assert.equal(copied.ok, true);
	const both = await readdir(join(project, "src"));
	assert.ok(both.includes("main.ts") && both.includes("main copy.ts"));
});

test("a directory cannot be moved inside itself", async () => {
	const result = await inProject<{ ok: boolean; code?: string }>(
		`return window.lyra.files.rename(P + "/src", P + "/src/deep/src")`,
	);
	assert.equal(result.ok, false);
	assert.equal(result.code, "descendant");
	// The point of the check: `rename` on some filesystems would have done it.
	assert.ok((await readdir(join(project, "src"))).includes("deep"), "src is intact");
});

test("`..` cannot walk out of the project, to read or to write", async () => {
	/*
	 * The regression this exists for: the boundary used to be a string prefix, and
	 * `<project>/../../etc/passwd` starts with `<project>/`. Reading it that way was a leak; with
	 * delete and rename on the same doorway it would have been considerably worse.
	 */
	const escaped = await inProject<{ read: unknown; created: { ok: boolean; code?: string } }>(`
		return {
			read: await window.lyra.files.read(P + "/../../etc/hosts"),
			created: await window.lyra.files.create(P + "/..", "escaped.txt", "file"),
		}
	`);
	assert.equal(escaped.read, null, "reading outside the project answered with contents");
	assert.equal(escaped.created.ok, false);
	assert.equal(escaped.created.code, "denied");
	assert.ok(!(await readdir(app.home)).includes("escaped.txt"), "nothing was written outside");
});

test("a name the filesystem would refuse is refused with a reason", async () => {
	const bad = await inProject<{ ok: boolean; code?: string; error?: string }>(
		`return window.lyra.files.create(P, "a/b", "file")`,
	);
	assert.equal(bad.ok, false);
	assert.equal(bad.code, "invalid");
	assert.match(bad.error ?? "", /\//, "the message says which character");
});

test("permanent delete removes a whole directory", async () => {
	const result = await inProject<{ ok: boolean }>(`return window.lyra.files.remove([P + "/docs"])`);
	assert.equal(result.ok, true);
	assert.ok(!(await readdir(project)).includes("docs"));
});

test("the clipboard round-trips through the main process", async () => {
	// The renderer's own `navigator.clipboard.readText` needs a permission nothing grants, so
	// paste in a context menu depends entirely on this path working in a packaged app.
	const text = await app.evaluate<string>(
		`(async () => { await window.lyra.clipboard.write("往返"); return window.lyra.clipboard.read(); })()`,
	);
	assert.equal(text, "往返");
});

/** What the layout check reads off the window, plus the steps it took to get there. */
interface Measured {
	window: number;
	panel: number;
	tree: number;
	search: number;
	trace: string[];
}

test("the file filter is as wide as the tree it filters, not as wide as the panel", async () => {
	/*
	 * It used to sit above both panes and stretch the full width of the panel — tolerable at 380px
	 * and absurd once the panel is opened to full screen, where a control acting on a 232px list
	 * was over a thousand pixels wide.
	 */
	const measured = await app.evaluate<Measured>(`(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const button = (label) => [...document.querySelectorAll("button")].find((b) => b.innerText.trim().startsWith(label));
		const width = (el) => (el ? el.getBoundingClientRect().width : 0);
		const panelWidth = () => width(document.querySelector(".ly-panel"));

		/*
		 * A note at each step, carried into the failure message.
		 *
		 * A width that comes out wrong says nothing about *when* it went wrong — whether the panel
		 * never opened, opened and stayed narrow, or opened and then reflowed. Reading that off the
		 * trace is what turned "the filter is 93% of the panel" into a renderer that had stopped
		 * delivering resize notifications while the window was covered.
		 */
		const trace = [];
		const snap = (tag) => trace.push(tag + ": panel=" + Math.round(panelWidth()) +
			" col=" + Math.round(width(document.querySelector("[data-ly-tree-column]"))) +
			" handle=" + Boolean(document.querySelector("[aria-label=调整文件树宽度]")) +
			" tree=" + Boolean(document.querySelector("[data-ly-tree]")));

		snap("start");
		button("文件")?.click();
		await wait(400);
		snap("tab clicked");
		// The toolbar mounts with the panel, so the first press can land before the button exists.
		for (let attempt = 0; attempt < 4 && panelWidth() < 600; attempt++) {
			document.querySelector("button[aria-label=全屏显示]")?.click();
			await wait(500);
			snap("expand " + attempt);
		}
		/*
		 * Then wait for the two columns, not just for the width.
		 *
		 * The panel's width changes on the frame the button is pressed; whether the tree and the
		 * file sit side by side is decided by a ResizeObserver inside the panel, which lands after.
		 * Measuring in between reads the stacked layout — where the tree column *is* the panel, so
		 * the assertion below would be comparing a thing to itself. The drag handle only exists in
		 * the side-by-side form, which makes it the signal to wait for.
		 */
		for (let attempt = 0; attempt < 10 && !document.querySelector("[aria-label=调整文件树宽度]"); attempt++) {
			await wait(200);
		}
		snap("settled");

		return {
			window: window.innerWidth,
			panel: panelWidth(),
			tree: width(document.querySelector("[data-ly-tree-column]")),
			search: width(document.querySelector(".ly-panel input")?.parentElement),
			trace,
		};
	})()`);

	assert.ok(
		measured.panel > 600,
		`the panel did not open full screen (${measured.panel}px in a ${measured.window}px window)`,
	);
	assert.ok(measured.search > 0, "no filter was found in the panel");
	assert.ok(
		measured.search <= measured.tree,
		`the filter (${measured.search}px) is wider than the tree column (${measured.tree}px)`,
	);
	assert.ok(
		measured.search < measured.panel / 2,
		`the filter is ${Math.round((measured.search / measured.panel) * 100)}% of the panel: ${JSON.stringify(measured)}`,
	);
});

// --- the same operations, through the tree rather than through the API ---------------------------
//
// The calls above prove the main process does the right thing. These prove the panel asks it to:
// that the menu item is wired to the operation, that the inline field commits what was typed, and
// that the tree and the pane beside it agree with the disk afterwards.

test("新建文件 puts a field in the tree, and Enter creates what was typed", async () => {
	await openFilePanel();
	const state = await ui<{ field: boolean; selected: string[]; editor: boolean }>(`
		openMenu(row("/src")); await wait(400);
		item("新建文件").click(); await wait(400);
		const field = document.querySelector("[data-ly-tree] input.ly-name-input");
		if (!field) return { field: false, selected: [], editor: false };
		type(field, "through-the-menu.ts"); await wait(800);
		return {
			field: true,
			selected: rows().filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.getAttribute("data-path")),
			editor: Boolean(document.querySelector(".ly-cm .cm-editor")),
		};
	`);

	assert.equal(state.field, true, "no inline field appeared");
	assert.equal(await readFile(join(project, "src", "through-the-menu.ts"), "utf8"), "");
	assert.deepEqual(state.selected, [join(project, "src", "through-the-menu.ts")], "the new file is selected");
	assert.equal(state.editor, true, "and open in the pane beside the tree");
});

test("F2 renames in place, with the extension left out of the selection", async () => {
	const state = await ui<{ range: [number, number] | null }>(`
		click(row("src/through-the-menu.ts")); await wait(300);
		key({ key: "F2" }); await wait(400);
		const field = document.querySelector("[data-ly-tree] input.ly-name-input");
		if (!field) return { range: null };
		const range = [field.selectionStart, field.selectionEnd];
		type(field, "renamed-in-place.ts"); await wait(800);
		return { range };
	`);

	// `through-the-menu` is 16 characters; `.ts` is not part of what a rename means to retype.
	assert.deepEqual(state.range, [0, 16], "the stem was not the pre-selected part");
	const listed = await readdir(join(project, "src"));
	assert.ok(listed.includes("renamed-in-place.ts") && !listed.includes("through-the-menu.ts"));
});

test("创建副本 makes a copy beside it with a free name", async () => {
	await ui(`
		openMenu(row("src/renamed-in-place.ts")); await wait(400);
		item("创建副本").click(); await wait(900);
	`);
	const listed = await readdir(join(project, "src"));
	assert.ok(listed.includes("renamed-in-place copy.ts"), `no copy in ${listed.join(", ")}`);
});

test("⌘⌫ asks first, and the answer decides what happens on disk", async () => {
	const asked = await ui<string>(`
		click(row("src/renamed-in-place copy.ts")); await wait(300);
		key({ key: "Backspace", metaKey: true }); await wait(500);
		const dialog = document.querySelector("[role=dialog]");
		return dialog ? label(dialog) : "";
	`);
	assert.match(asked, /renamed-in-place copy\.ts/, "the question does not name what it would delete");
	assert.match(asked, /废纸篓/, "and does not say where it would go");

	// Cancelling leaves it alone — the half of a confirmation that is easy to get wrong.
	await ui(`confirm("取消"); await wait(400);`);
	assert.ok((await readdir(join(project, "src"))).includes("renamed-in-place copy.ts"), "cancel deleted it anyway");

	await ui(`
		key({ key: "Backspace", metaKey: true }); await wait(500);
		confirm("移到废纸篓"); await wait(900);
	`);
	assert.ok(!(await readdir(join(project, "src"))).includes("renamed-in-place copy.ts"), "confirm did not delete it");
});

test("cut and paste moves a file between folders", async () => {
	await inProject(`return window.lyra.files.create(P, "elsewhere", "directory")`);
	// The folder was made through the API, so the tree has not heard about it yet.
	await ui(`
		openMenu(row("/src")); await wait(300);
		item("刷新").click(); await wait(600);
		click(row("src/renamed-in-place.ts")); await wait(300);
		key({ key: "x", metaKey: true }); await wait(300);
		click(row("/elsewhere")); await wait(400);
		key({ key: "v", metaKey: true }); await wait(900);
	`);

	assert.ok((await readdir(join(project, "elsewhere"))).includes("renamed-in-place.ts"), "it did not arrive");
	assert.ok(!(await readdir(join(project, "src"))).includes("renamed-in-place.ts"), "and it did not leave");
});

// --- toasts -------------------------------------------------------------------------------------

test("a refused operation says so, above everything else on screen", async () => {
	const shown = await ui<{
		text: string;
		zIndex: number;
		highestElsewhere: number;
		highestName: string;
		hitByItself: boolean;
		inBody: boolean;
		centred: boolean;
	}>(`
		openMenu(row("/src")); await wait(350);
		item("复制 ⌘C").click(); await wait(350);
		openMenu(row("src/deep")); await wait(350);
		item("粘贴").click(); await wait(800);

		const card = toasts()[0];
		const host = card.parentElement;
		const box = card.getBoundingClientRect();
		const hit = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
		// Everything that is not this stack, ranked. Named, so a failure says what would cover it.
		const others = [...document.querySelectorAll("body *")]
			.filter((el) => el !== host && !host.contains(el))
			.map((el) => ({ z: Number(getComputedStyle(el).zIndex), name: el.tagName + "." + String(el.className).slice(0, 40) }))
			.filter((el) => Number.isFinite(el.z))
			.sort((a, b) => b.z - a.z);

		return {
			text: label(card),
			zIndex: Number(getComputedStyle(host).zIndex),
			highestElsewhere: others[0]?.z ?? 0,
			highestName: others[0]?.name ?? "(nothing)",
			hitByItself: card.contains(hit),
			inBody: host.parentElement === document.body,
			centred: Math.abs((box.left + box.right) / 2 - window.innerWidth / 2) <= 2,
		};
	`);

	assert.match(shown.text, /不能把文件夹复制到它自己里面/);
	assert.equal(shown.inBody, true, "it is not portalled out of the layout that would clip it");
	assert.ok(
		shown.zIndex > shown.highestElsewhere,
		`a toast at ${shown.zIndex} can be covered by ${shown.highestName} at ${shown.highestElsewhere}`,
	);
	// The z-index is a claim; this is the observation. Nothing is painted over its middle.
	assert.equal(shown.hitByItself, true, "something is on top of the toast");
	assert.equal(shown.centred, true);
});

test("nothing between the shell and the page can trap a layer above the toast", async () => {
	/*
	 * `z-index` only settles arguments inside one stacking context, so "the toast is at 1000" is
	 * only the whole story while the things it must outrank are in the same context. The image
	 * viewer (100) and its annotator (120) are drawn inside `.ly-shell`; if anything on the way up
	 * to `<body>` ever grows a `transform`, an `opacity` below 1 or a `will-change`, that subtree
	 * becomes its own context and the viewer starts covering toasts — with every number unchanged
	 * and nothing to notice.
	 */
	const trapped = await app.evaluate<{ node: string; makes: string[] }[]>(`(() => {
		const makes = (el) => {
			const c = getComputedStyle(el);
			return [
				c.transform !== "none" && "transform",
				c.filter !== "none" && "filter",
				c.opacity !== "1" && "opacity",
				c.isolation === "isolate" && "isolation",
				c.willChange !== "auto" && "will-change",
				c.mixBlendMode !== "normal" && "mix-blend-mode",
				c.contain.includes("paint") && "contain:paint",
				c.zIndex !== "auto" && c.position !== "static" && "z-index",
			].filter(Boolean);
		};
		const chain = [];
		for (let el = document.querySelector(".ly-shell"); el && el !== document.body; el = el.parentElement) {
			chain.push({ node: el.tagName + (el.id ? "#" + el.id : ""), makes: makes(el) });
		}
		return chain.filter((step) => step.makes.length > 0);
	})()`);

	assert.deepEqual(
		trapped,
		[],
		`these would put the image viewer in its own stacking context: ${JSON.stringify(trapped)}`,
	);
});

test("the same failure twice is one card that counts, not two cards", async () => {
	const stack = await ui<{ cards: number; text: string }>(`
		for (let attempt = 0; attempt < 2; attempt++) {
			openMenu(row("src/deep")); await wait(300);
			item("粘贴").click(); await wait(600);
		}
		return { cards: toasts().length, text: toasts().map(label).join(" | ") };
	`);

	assert.equal(stack.cards, 1, `expected one card, got: ${stack.text}`);
	assert.match(stack.text, /×\s*\d/, "the repeat is not counted anywhere");
});

test("hovering holds a toast open, and the close button takes it away", async () => {
	const held = await ui<{ afterHover: number; afterClose: number }>(`
		const card = toasts()[0];
		// React synthesises enter/leave from delegated over/out, so those are what have to be sent.
		card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
		// Well past the longest lifetime: without the hold it would be long gone.
		await wait(10000);
		const afterHover = toasts().length;

		card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
		card.querySelector("button[aria-label=关闭]").click();
		await wait(500);
		return { afterHover, afterClose: toasts().length };
	`);

	assert.equal(held.afterHover, 1, "the toast expired while the pointer was on it");
	assert.equal(held.afterClose, 0, "the close button left it on screen");
});

test("a toast goes on its own once nothing is holding it", async () => {
	const gone = await ui<{ atFirst: number; later: number }>(`
		openMenu(row("src/deep")); await wait(300);
		item("粘贴").click(); await wait(600);
		const atFirst = toasts().length;
		await wait(10000);
		return { atFirst, later: toasts().length };
	`);

	assert.equal(gone.atFirst, 1);
	assert.equal(gone.later, 0, "it is still there, so nothing would ever clear a stack of them");
});
