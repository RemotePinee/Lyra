/**
 * Dragging the sidebar's edge.
 *
 * The interesting claim is not that the width changes — it always did — but that changing it costs
 * nothing while the drag is under way. The width lives in a context whose value is memoised on it,
 * so a `setState` per frame produced a fresh context value sixty times a second and re-rendered
 * every consumer, transcript included; on a long conversation that was the frame budget spent
 * before the browser laid anything out, and it showed as the panes juddering.
 *
 * That is hard to assert on directly, so it is asserted on its two visible consequences: the pane
 * follows the pointer during the drag, and nothing is committed until the pointer is released.
 * `localStorage` is the witness for the second — it used to be written on every frame.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";

let app: RunningApp;

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
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
	app = await startApp({ port: 9487, seed });
	await new Promise((r) => setTimeout(r, 800));
});

after(async () => {
	await app?.stop();
});

/** The pane the handle resizes, and what has been written down about it. */
const state = () =>
	app.evaluate<{ width: number; stored: string | null }>(`(() => {
		const handle = document.querySelector('[role="separator"][aria-label="调整侧边栏宽度"]');
		return {
			width: Math.round(handle.parentElement.getBoundingClientRect().width),
			stored: window.localStorage.getItem("dw:sidebar-width"),
		};
	})()`);

test("the pane follows the pointer, and nothing is committed until it is released", async () => {
	const before = await state();
	assert.ok(before.width > 0, "the sidebar is showing");

	// Press, then move in steps, sampling the pane and the stored value as we go.
	const during = await app.evaluate<{ widths: number[]; stored: (string | null)[] }>(`(async () => {
		const handle = document.querySelector('[role="separator"][aria-label="调整侧边栏宽度"]');
		const box = handle.getBoundingClientRect();
		const x0 = Math.round(box.left + box.width / 2);
		const y = Math.round(box.top + 120);
		const frame = handle.parentElement;

		handle.dispatchEvent(new MouseEvent("mousedown", { clientX: x0, clientY: y, bubbles: true, button: 0 }));
		const widths = [];
		const stored = [];
		for (let i = 1; i <= 6; i++) {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: x0 + i * 8, clientY: y, bubbles: true, button: 0 }));
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			widths.push(Math.round(frame.getBoundingClientRect().width));
			stored.push(window.localStorage.getItem("dw:sidebar-width"));
		}
		window.dispatchEvent(new MouseEvent("mouseup", { clientX: x0 + 48, clientY: y, bubbles: true, button: 0 }));
		await new Promise((r) => setTimeout(r, 120));
		return { widths, stored };
	})()`);

	// It tracked the pointer: each sample is wider than the last, and wider than where it started.
	assert.ok(
		during.widths.every((w, i) => i === 0 || w >= during.widths[i - 1]),
		`the pane widened monotonically (${during.widths.join(", ")})`,
	);
	assert.ok(during.widths[during.widths.length - 1] > before.width, "and ended wider than it began");

	/*
	 * And none of that reached storage.
	 *
	 * This is the assertion that would have failed before: the width was written to `localStorage`
	 * inside the same `setState` that ran on every frame, so these six samples would have held six
	 * increasing numbers rather than six copies of the original.
	 */
	assert.deepEqual(
		[...new Set(during.stored)],
		[before.stored],
		`nothing was written mid-drag (${JSON.stringify(during.stored)})`,
	);

	// Releasing commits exactly what is on screen.
	const settled = await state();
	assert.equal(Number(settled.stored), settled.width, "the released width is the width that was stored");
	assert.ok(settled.width > before.width, "and it is the width the drag arrived at");
});

test("the keyboard moves the edge and commits immediately", async () => {
	/*
	 * The other path through the same handle. A keypress is a single step rather than a stream, so
	 * there is nothing to defer — and deferring it would mean an arrow key that changed the layout
	 * and then forgot it.
	 */
	const before = await state();
	await app.evaluate(`(() => {
		const handle = document.querySelector('[role="separator"][aria-label="调整侧边栏宽度"]');
		handle.focus();
		handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
		return true;
	})()`);
	await new Promise((r) => setTimeout(r, 250));

	const after = await state();
	assert.ok(after.width < before.width, `the edge moved in (${before.width} → ${after.width})`);
	assert.equal(Number(after.stored), after.width, "and the new width was stored at once");
});
