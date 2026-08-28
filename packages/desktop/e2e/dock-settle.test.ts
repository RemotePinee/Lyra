/**
 * Adopting a layout is not a movement, so nothing about it animates.
 *
 * Every switch between conversations loads that conversation's saved layout, and `DockView` marks
 * the document with `data-dock-settling` for the two frames that takes so the panes land rather
 * than travel. That flag used to suppress the entrance with `animation: none` — and an animation
 * is bound to its element by *name*, so putting the name back started a fresh one. The flag whose
 * whole purpose was to stop panes animating was replaying the entrance of every pane in the dock,
 * two frames after every switch: measured from `opacity`, 0 → 1 over eleven frames, on the
 * conversation as well as the panels.
 *
 * Both halves are asserted here, because fixing one by losing the other would be no fix: a pane
 * that is genuinely new must still fade in, and one that was already there must not.
 *
 * Measured from `opacity` rather than from class names or animation bookkeeping — what is being
 * claimed is about what the eye sees.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";

let app: RunningApp;

before(async () => {
	app = await startApp({ port: 9448 });
});

after(async () => {
	await app?.stop();
});

/** `opacity` of the first pane on screen, once per frame. */
async function opacityOverFrames(setup: string, frames: number): Promise<number[]> {
	return app.evaluate<number[]>(`(async () => {
		const pane = document.querySelector("[data-dock-pane]");
		if (!pane) throw new Error("no pane on screen");
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		${setup}
		const out = [];
		for (let i = 0; i < ${frames}; i++) {
			out.push(Number(getComputedStyle(pane).opacity));
			await frame();
		}
		return out;
	})()`);
}

test("a pane already on screen does not fade when the settling flag is lifted", async () => {
	// Exactly what a conversation switch does: raise the flag, let the layout be adopted, drop it
	// two frames later.
	const samples = await opacityOverFrames(
		`
		document.documentElement.dataset.dockSettling = "";
		await frame();
		await frame();
		delete document.documentElement.dataset.dockSettling;
		`,
		14,
	);

	const faded = samples.filter((value) => value < 0.99);
	assert.deepEqual(faded, [], `a pane replayed its entrance: ${samples.join(" ")}`);
});

test("a pane that is genuinely new still arrives rather than appearing", async () => {
	const samples = await app.evaluate<number[]>(`(async () => {
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		const host = document.querySelector(".ly-dock") ?? document.body;
		const el = document.createElement("div");
		el.className = "ly-dock-pane";
		el.style.cssText = "position:absolute;left:0;top:0;width:10px;height:10px;pointer-events:none";
		host.appendChild(el);
		const out = [];
		for (let i = 0; i < 10; i++) {
			out.push(Number(getComputedStyle(el).opacity));
			await frame();
		}
		el.remove();
		return out;
	})()`);

	assert.ok(samples[0] < 0.5, `a new pane blinked into existence: ${samples.join(" ")}`);
	assert.ok(samples[samples.length - 1] > 0.9, `a new pane never finished arriving: ${samples.join(" ")}`);
});

test("and lands instantly while the dock is settling, which is what the flag is for", async () => {
	const samples = await app.evaluate<number[]>(`(async () => {
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		const host = document.querySelector(".ly-dock") ?? document.body;
		document.documentElement.dataset.dockSettling = "";
		const el = document.createElement("div");
		el.className = "ly-dock-pane";
		el.style.cssText = "position:absolute;left:0;top:0;width:10px;height:10px;pointer-events:none";
		host.appendChild(el);
		const out = [];
		for (let i = 0; i < 6; i++) {
			out.push(Number(getComputedStyle(el).opacity));
			await frame();
		}
		el.remove();
		delete document.documentElement.dataset.dockSettling;
		return out;
	})()`);

	assert.deepEqual(
		samples.filter((value) => value < 0.99),
		[],
		`a pane animated in while the dock was settling: ${samples.join(" ")}`,
	);
});
