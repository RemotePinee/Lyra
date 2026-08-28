/* oxlint-disable no-console -- performance probe CLI that prints timing measurements */
/**
 * Does taking `data-dock-settling` off replay every pane's entrance?
 *
 * `.ly-dock-pane` carries `animation: ly-pane-in`, and the settling flag suppresses it with
 * `animation: none`. Removing the flag puts the animation name back — which, if the browser treats
 * that as a new animation, means every pane in the dock fades in two frames after the flag is
 * dropped. That is exactly the "switching conversations looks unnatural" report, so it is worth an
 * answer from the real renderer rather than an argument about the spec.
 *
 * Measured from `opacity`, which is what the eye sees, not from the animation's own bookkeeping.
 */

import { startApp } from "./app.ts";

async function main() {
	const app = await startApp({ port: 9334 });
	try {
		const result = await app.evaluate<{ before: number[]; settled: number[]; names: string[] }>(`(async () => {
			const pane = document.querySelector("[data-dock-pane]");
			if (!pane) throw new Error("no pane on screen");
			const frame = () => new Promise((r) => requestAnimationFrame(r));
			const sample = async (n) => {
				const out = [];
				for (let i = 0; i < n; i++) {
					out.push(Number(getComputedStyle(pane).opacity));
					await frame();
				}
				return out;
			};

			// Idle: nothing should be moving.
			const before = await sample(6);

			// What DockView does on a conversation switch: flag, adopt, then two frames later unflag.
			document.documentElement.dataset.dockSettling = "";
			const names = [getComputedStyle(pane).animationName];
			await frame();
			await frame();
			delete document.documentElement.dataset.dockSettling;
			names.push(getComputedStyle(pane).animationName);
			const settled = await sample(14);

			return { before, settled, names };
		})()`);

		console.log("animation-name with the flag on/off:", result.names.join(" -> "));
		console.log("opacity while idle      :", result.before.map((n) => n.toFixed(2)).join(" "));
		console.log("opacity after unflagging:", result.settled.map((n) => n.toFixed(2)).join(" "));
		const replayed = result.settled.some((n) => n < 0.99);
		console.log(replayed ? "\nREPLAYED: the entrance runs again on every switch." : "\nno replay.");
	} finally {
		await app.stop();
	}
}

await main();
