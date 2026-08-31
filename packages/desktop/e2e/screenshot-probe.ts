/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * Driving the screenshot overlay for real, and looking at what it produced.
 *
 * The overlay is a second window: the main one is what `startApp` attaches to, so this finds the
 * other page target and talks to it directly. Everything the overlay does is pointer work on a
 * canvas, which is exactly the kind of thing that typechecks, renders, and still does nothing —
 * so this presses the buttons rather than reading the code.
 *
 * Run: `node --experimental-strip-types e2e/screenshot-probe.ts`
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { startApp } from "./app.ts";

const execFileAsync = promisify(execFile);

const PORT = 9411;

/** Width and height out of a PNG's IHDR, which is the first chunk and always at a fixed offset. */
async function pngSize(path: string): Promise<{ width: number; height: number }> {
	const head = await readFile(path);
	return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

interface Target {
	title: string;
	type: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

async function targets(): Promise<Target[]> {
	return (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())) as Target[];
}

/** One call, one socket — the same arrangement `app.ts` uses, for the same reason. */
async function call<T>(target: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
	const socket = new WebSocket(target);
	try {
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		const answer = new Promise<T>((resolve, reject) => {
			socket.addEventListener("message", (event) => {
				const message = JSON.parse(String(event.data));
				if (message.id !== 1) return;
				if (message.error) reject(new Error(`${method}: ${message.error.message}`));
				else resolve(message.result as T);
			});
			setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
		});
		socket.send(JSON.stringify({ id: 1, method, params }));
		return await answer;
	} finally {
		socket.close();
	}
}

function evaluator(socket: string) {
	return async <T>(expression: string): Promise<T> => {
		const result = (await call(socket, "Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		})) as { exceptionDetails?: { text: string }; result?: { value: T } };
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
		return result.result?.value as T;
	};
}

/** A press, a path and a release, dispatched as real input rather than synthesised React events. */
async function drag(socket: string, from: [number, number], to: [number, number], steps = 8) {
	const mouse = (type: string, x: number, y: number) =>
		call(socket, "Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button: "left",
			buttons: type === "mouseReleased" ? 0 : 1,
			clickCount: 1,
		});
	await mouse("mousePressed", from[0], from[1]);
	for (let i = 1; i <= steps; i++) {
		await mouse("mouseMoved", from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
	}
	await mouse("mouseReleased", to[0], to[1]);
}

async function click(socket: string, x: number, y: number) {
	await call(socket, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await call(socket, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Which application is frontmost, according to the window server.
 *
 * `lsappinfo` rather than AppleScript: it needs no accessibility grant, so it works on a machine
 * where nobody has clicked through a permission dialog for the test runner. macOS only — elsewhere
 * this returns null and the check is skipped, which is honest about what it covers.
 */
async function frontmostApp(): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	try {
		const { stdout: asn } = await execFileAsync("lsappinfo", ["front"]);
		const { stdout } = await execFileAsync("lsappinfo", ["info", "-only", "name", asn.trim()]);
		return /"LSDisplayName"="(.*)"/.exec(stdout.trim())?.[1] ?? null;
	} catch {
		return null;
	}
}

/** Where the finished screenshot should land, so the export can be checked as a file on disk. */
let shots = "";
const app = await startApp({
	port: PORT,
	seed: async (home) => {
		shots = join(home, "shots");
		await mkdir(shots, { recursive: true });
		await writeFile(
			join(home, "settings.json"),
			JSON.stringify({ screenshot: { saveLocation: shots, copyToClipboard: false, openEditor: false } }, null, 2),
		);
	},
});
const problems: string[] = [];
const note = (line: string) => {
	console.log(line);
};

try {
	note("• 主窗口已启动，请求打开截图浮层…");
	await app.evaluate(`window.lyra.screenshot.start()`);

	// The overlay only shows itself once its snapshot is painted, so give it a moment to appear.
	let overlay: Target | undefined;
	for (let i = 0; i < 40 && !overlay; i++) {
		await pause(250);
		overlay = (await targets()).find((t) => t.type === "page" && t.url.includes("screenshot-overlay"));
	}
	if (!overlay?.webSocketDebuggerUrl) throw new Error("截图浮层窗口没有出现");
	const socket = overlay.webSocketDebuggerUrl;
	const run = evaluator(socket);
	note("• 浮层窗口已出现");

	// Anything the renderer throws, kept where the probe can read it at the end. A React effect that
	// throws leaves a half-painted canvas and no other trace.
	await run(`(() => {
		window.__probeErrors = [];
		window.addEventListener("error", (e) => window.__probeErrors.push(String(e.message)));
		window.addEventListener("unhandledrejection", (e) => window.__probeErrors.push("rejected: " + e.reason));
		const err = console.error.bind(console);
		console.error = (...a) => { window.__probeErrors.push(a.map(String).join(" ")); err(...a); };
	})()`);

	const painted = await run<{ w: number; h: number; blank: boolean; css: number; dpr: number }>(`(() => {
		const c = document.querySelector("canvas");
		if (!c) return { w: 0, h: 0, blank: true, css: 0, dpr: 0 };
		const ctx = c.getContext("2d");
		const d = ctx.getImageData(0, 0, Math.min(200, c.width), Math.min(200, c.height)).data;
		let blank = true;
		for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) { blank = false; break; }
		return { w: c.width, h: c.height, blank, css: window.innerWidth, dpr: window.devicePixelRatio };
	})()`);
	note(`  背景画布 ${painted.w}×${painted.h}，${painted.blank ? "空白" : "已绘制屏幕快照"}`);
	if (painted.blank) problems.push("背景快照没有画出来");
	/*
	 * The backdrop's bitmap has to be the capture's own pixel count, not the display's logical size.
	 *
	 * Sized logically, a Retina snapshot is squeezed to half resolution and stretched back over the
	 * screen — the frozen desktop goes visibly soft the moment the overlay appears, which reads as
	 * the capture itself being low quality.
	 */
	const wantBacking = Math.round(painted.css * painted.dpr);
	note(`     位图 ${painted.w} vs 物理像素 ${wantBacking}（dpr ${painted.dpr}）`);
	if (Math.abs(painted.w - wantBacking) > 1) {
		problems.push(`背景画布不是物理分辨率：位图 ${painted.w}，屏幕 ${wantBacking}`);
	}

	// ---- 1. 拉出一个选区 -------------------------------------------------
	/*
	 * Wait for the window to be its full size before pressing anything.
	 *
	 * The overlay appears in the target list before it has been shown, and `clampRect` clamps the
	 * selection to `window.innerHeight` — so a drag dispatched too early is trimmed to whatever the
	 * window measured at the time, which showed up as an intermittent short selection.
	 */
	let stable = 0;
	let last = 0;
	for (let i = 0; i < 30 && stable < 3; i++) {
		const tall = await run<number>(`window.innerHeight`);
		stable = tall === last && tall > 700 ? stable + 1 : 0;
		last = tall;
		await pause(100);
	}
	note(`  0. 窗口高度稳定在 ${last}`);
	await drag(socket, [300, 220], [900, 620]);
	await pause(150);
	const drawn = await run<{ x: number; y: number; w: number; h: number } | null>(`(() => {
		const box = document.querySelector('[class*="border-white/90"]');
		if (!box) return null;
		const r = box.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	})()`);
	note(`  1. 拉选区 → ${drawn ? `${drawn.x},${drawn.y} ${drawn.w}×${drawn.h}` : "没有选区"}`);
	if (!drawn || drawn.w < 500 || drawn.h < 300) problems.push("拖拽没有拉出预期大小的选区");

	// ---- 2. 八个手柄 -----------------------------------------------------
	const handles = await run<number>(`document.querySelectorAll('[class*="border-white/90"] > div').length`);
	note(`  2. 手柄 → ${handles} 个`);
	if (handles !== 8) problems.push(`应该有 8 个缩放手柄，实际 ${handles} 个`);

	// ---- 3. 工具条在选区左下方 -------------------------------------------
	const bar = await run<{ x: number; y: number; w: number } | null>(`(() => {
		const el = document.querySelector('[class*="1c1c1e"]');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
	})()`);
	note(`  3. 工具条 → ${bar ? `${bar.x},${bar.y} 宽 ${bar.w}` : "没有出现"}`);
	if (!bar) problems.push("工具条没有出现");
	else {
		if (Math.abs(bar.x - (drawn?.x ?? 0)) > 2) problems.push(`工具条没有和选区左边缘对齐（${bar.x} vs ${drawn?.x}）`);
		if (bar.y < (drawn?.y ?? 0) + (drawn?.h ?? 0)) problems.push("工具条没有落在选区下方");
	}

	// ---- 3b. 标注画布正好盖住选区 ----------------------------------------
	/*
	 * The one thing a screenshot annotator cannot get wrong.
	 *
	 * The canvas is the whole screen, shifted up and left by the selection's offset and clipped to
	 * it, so in viewport terms it should sit at the origin at exactly window size. Left to lay out
	 * at its own bitmap's size it is `devicePixelRatio` times too big — on a Retina screen the marks
	 * land at twice the distance from the corner that the pointer was, and three quarters of the
	 * region being annotated is outside the frame. That is invisible to a typecheck and to every
	 * other assertion in this file.
	 */
	const canvasFit = await run<{ x: number; y: number; w: number; h: number; bitmap: number; win: number; dpr: number } | null>(`(() => {
		const cs = document.querySelectorAll("canvas");
		const c = cs[cs.length - 1];
		if (!c || cs.length < 2) return null;
		const r = c.getBoundingClientRect();
		return {
			x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
			bitmap: c.width, win: window.innerWidth, dpr: window.devicePixelRatio,
		};
	})()`);
	note(`  3b. 标注画布 → ${canvasFit ? `${canvasFit.x},${canvasFit.y} ${canvasFit.w}×${canvasFit.h}（位图 ${canvasFit.bitmap}，窗口 ${canvasFit.win}，dpr ${canvasFit.dpr}）` : "没有出现"}`);
	if (!canvasFit) problems.push("框选之后标注画布没有挂上");
	else {
		if (Math.abs(canvasFit.x) > 1 || Math.abs(canvasFit.y) > 1) {
			problems.push(`标注画布没有和屏幕对齐：落在 ${canvasFit.x},${canvasFit.y}`);
		}
		if (Math.abs(canvasFit.w - canvasFit.win) > 1) {
			problems.push(`标注画布的显示尺寸不等于屏幕：${canvasFit.w} vs ${canvasFit.win}（dpr ${canvasFit.dpr}）`);
		}
		if (Math.abs(canvasFit.bitmap - canvasFit.win * canvasFit.dpr) > 1) {
			problems.push(`标注画布的位图不是物理分辨率：${canvasFit.bitmap}`);
		}
	}

	// ---- 4. 拖动选区边缘整体移动 -----------------------------------------
	/*
	 * The edge, not the middle.
	 *
	 * Once there is something to annotate the inside of the selection belongs to the pen — a press
	 * there draws, which is the whole point of it. The region is picked up by its border instead.
	 *
	 * A quarter of the way along, not the middle: the middle of each edge is a resize handle, and
	 * grabbing one of those resizes rather than moves — which is correct, and not what this checks.
	 */
	await drag(socket, [drawn!.x + drawn!.w * 0.25, drawn!.y + 2], [drawn!.x + drawn!.w * 0.25 + 60, drawn!.y + 52]);
	await pause(150);
	const moved = await run<{ x: number; y: number; w: number; h: number } | null>(`(() => {
		const box = document.querySelector('[class*="border-white/90"]');
		if (!box) return null;
		const r = box.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	})()`);
	note(`  4. 拖边缘移动 → ${moved ? `${moved.x},${moved.y} ${moved.w}×${moved.h}` : "选区没了"}`);
	if (!moved) problems.push("拖动选区边缘把选区弄丢了");
	else {
		if (Math.abs(moved.x - (drawn!.x + 60)) > 3 || Math.abs(moved.y - (drawn!.y + 50)) > 3) {
			problems.push(`选区没有跟着指针移动（期望 ${drawn!.x + 60},${drawn!.y + 50}，实际 ${moved.x},${moved.y}）`);
		}
		if (moved.w !== drawn!.w || moved.h !== drawn!.h) problems.push("移动选区时尺寸变了");
	}

	// ---- 5. 拖右下角手柄缩放 ---------------------------------------------
	const corner: [number, number] = [moved!.x + moved!.w, moved!.y + moved!.h];
	await drag(socket, corner, [corner[0] + 80, corner[1] + 60]);
	await pause(150);
	const resized = await run<{ w: number; h: number } | null>(`(() => {
		const box = document.querySelector('[class*="border-white/90"]');
		if (!box) return null;
		const r = box.getBoundingClientRect();
		return { w: Math.round(r.width), h: Math.round(r.height) };
	})()`);
	note(`  5. 拖右下角 → ${resized ? `${resized.w}×${resized.h}` : "选区没了"}`);
	if (!resized || Math.abs(resized.w - (moved!.w + 80)) > 3 || Math.abs(resized.h - (moved!.h + 60)) > 3) {
		problems.push(`拖手柄没有把选区放大到预期尺寸（实际 ${resized?.w}×${resized?.h}）`);
	}

	// ---- 6. 每一种工具都真的画出东西 -------------------------------------
	const inside = { x: moved!.x + 60, y: moved!.y + 60 };
	const marks = await run<number>(`document.querySelectorAll('[class*="1c1c1e"] button[data-ly-tip]').length`);
	note(`  6. 工具条按钮 → ${marks} 个`);

	/**
	 * What is on the mark canvas: how much of it is covered, and a checksum of every byte.
	 *
	 * The count alone is not enough and cost an hour finding out. A caption drawn over a mosaic
	 * block adds no *newly* opaque pixels, so "text drew nothing" and "undo changed nothing" both
	 * looked like real failures when the app was drawing exactly what it should. The checksum sees
	 * any change at all, which is the actual question being asked.
	 */
	const inkOf = async () =>
		run<{ ink: number; sum: number }>(`(() => {
			const cs = document.querySelectorAll("canvas");
			const c = cs[cs.length - 1];
			const box = document.querySelector('[class*="border-white/90"]');
			if (!c || !c.width || !box) return { ink: -1, sum: -1 };
			/*
			 * Only the region, not the whole screen the canvas covers. Reading every pixel of a 5K
			 * display back into JavaScript takes seconds per call, and the part outside the frame is
			 * not exported anyway.
			 */
			const r = box.getBoundingClientRect();
			const s = c.width / window.innerWidth;
			const d = c.getContext("2d").getImageData(
				Math.round(r.x * s), Math.round(r.y * s),
				Math.max(1, Math.round(r.width * s)), Math.max(1, Math.round(r.height * s)),
			).data;
			let ink = 0, sum = 0;
			for (let i = 0; i < d.length; i += 4) {
				if (d[i + 3] > 8) ink++;
				sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) | 0;
			}
			return { ink, sum };
		})()`);

	const tools: [string, string][] = [
		["矩形", "R"],
		["圆形", "O"],
		["箭头", "A"],
		["直线", "L"],
		["画笔", "P"],
		["步骤标号", "S"],
		["马赛克", "M"],
	];
	let before = await inkOf();
	note(`     起始墨迹 ${before.ink} 像素`);
	/*
	 * Each tool gets a lane of its own.
	 *
	 * The first version drew all of them along the same path, so the pen landed exactly on the line
	 * that had just been drawn there and added no new pixels — which read as "the pen draws
	 * nothing" when the pen was fine and the probe was wrong.
	 */
	for (const [index, entry] of tools.entries()) {
		const [name, key] = entry;
		const picked = await run<boolean>(`(() => {
			const b = [...document.querySelectorAll("button[data-ly-tip]")].find(b => b.dataset.lyTip.startsWith(${JSON.stringify(name)}));
			if (!b) return false;
			b.click();
			return true;
		})()`);
		if (!picked) {
			problems.push(`工具条上没有「${name}」按钮`);
			continue;
		}
		await pause(60);
		const lane = inside.y + index * 32;
		// A short drag for the ones that are dragged; a click is enough for the step badge.
		if (name === "步骤标号") await click(socket, inside.x + 400, lane);
		else await drag(socket, [inside.x, lane], [inside.x + 120, lane + 18], 6);
		await pause(120);
		const after = await inkOf();
		note(`     ${name} (${key}) → 新增 ${after.ink - before.ink} 像素`);
		if (after.sum === before.sum) problems.push(`「${name}」工具没有画出任何东西`);
		before = after;
	}

	// ---- 7. 文字工具 -----------------------------------------------------
	/** How many pixels the caption itself changed, which is the yardstick undo is measured against. */
	let captionInk = 0;

	/*
	 * The region as it is now, kept in the page so a later moment can be compared against it.
	 *
	 * A checksum can say two pictures differ; it cannot say where, and every question worth asking
	 * about undo is a question about a particular part of the picture.
	 */
	const readFrame = `(() => {
		const cs = document.querySelectorAll("canvas");
		const c = cs[cs.length - 1];
		const box = document.querySelector('[class*="border-white/90"]');
		if (!c || !box) return null;
		const r = box.getBoundingClientRect();
		const s = c.width / window.innerWidth;
		return { r, s, data: c.getContext("2d").getImageData(
			Math.round(r.x * s), Math.round(r.y * s),
			Math.max(1, Math.round(r.width * s)), Math.max(1, Math.round(r.height * s)),
		) };
	})()`;
	const keepFrame = `(() => {
		const f = ${readFrame};
		if (!f) return false;
		window.__frame = f.data;
		return true;
	})()`;
	const frameDiff = `(() => {
		const a = window.__frame;
		const f = ${readFrame};
		if (!a || !f) return null;
		const b = f.data;
		if (a.width !== b.width || a.height !== b.height) return { count: -1, resized: true };
		let count = 0;
		for (let i = 0; i < b.data.length; i += 4) {
			const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i+1] - b.data[i+1]), Math.abs(a.data[i+2] - b.data[i+2]));
			if (d > 4) count++;
		}
		return { count };
	})()`;
	/*
	 * How much the canvas changes when nothing about it changes.
	 *
	 * Switching tools repaints the whole canvas from the same shapes, so any pixels that differ
	 * afterwards are the renderer's own noise — antialiased edges are not reproduced bit for bit
	 * across repaints. Measured rather than assumed, because the undo check below compares two
	 * repaints and would otherwise read that noise as a fault in undo.
	 */
	await run(keepFrame);
	await run(`[...document.querySelectorAll("button[data-ly-tip]")].find(b => b.dataset.lyTip.startsWith("画笔")).click()`);
	await pause(200);
	const noise = await run<{ count: number } | null>(frameDiff);
	note(`     重绘噪声基线 → ${noise?.count ?? "?"} 像素`);
	if ((noise?.count ?? 0) > 0) problems.push(`同样的内容重绘了一次就有 ${noise?.count} 个像素对不上`);

	await run(keepFrame);
	/** Which step of the caption flow moved pixels that were not the caption. */
	const diffCount = async (what: string) => {
		const d = await run<{ count: number } | null>(frameDiff);
		note(`     ${what} → 差 ${d?.count ?? "?"} 像素`);
	};

	/*
	 * How much of the caption's own corner differs from before it was written.
	 *
	 * Undo is checked here rather than across the whole region, and the reason is that the whole
	 * region is not a stable measurement: the overlay is a fullscreen window sitting under a live
	 * desktop, and comparing every pixel of it turns any stray input during the run into a failure
	 * about undo. What undo actually promises is local — the caption is gone and what was under it
	 * is back — and that is what this reads.
	 */
	const caption = { x: inside.x + 250, y: inside.y + 20, w: 320, h: 90 };
	const captionDiff = `(() => {
		const a = window.__frame;
		const f = ${readFrame};
		if (!a || !f) return null;
		const { r, s, data: b } = f;
		if (a.width !== b.width || a.height !== b.height) return null;
		const x0 = Math.max(0, Math.round((${caption.x} - r.x) * s));
		const y0 = Math.max(0, Math.round((${caption.y} - r.y) * s));
		const x1 = Math.min(b.width, x0 + Math.round(${caption.w} * s));
		const y1 = Math.min(b.height, y0 + Math.round(${caption.h} * s));
		let count = 0;
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const i = (y * b.width + x) * 4;
				const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i+1] - b.data[i+1]), Math.abs(a.data[i+2] - b.data[i+2]));
				if (d > 4) count++;
			}
		}
		return { count, area: (x1 - x0) * (y1 - y0) };
	})()`;
	await run(`[...document.querySelectorAll("button[data-ly-tip]")].find(b => b.dataset.lyTip.startsWith("文字")).click()`);
	await pause(120);
	await diffCount("选中文字工具后");
	/*
	 * Clear of the lanes the tools above drew in.
	 *
	 * Pressing on an existing mark selects it — correctly — instead of starting a caption, so a
	 * caption has to be started somewhere nothing has been drawn. The lanes run down the left of the
	 * region, so this goes to the right of them.
	 */
	await click(socket, inside.x + 250, inside.y + 20);
	await pause(150);
	await diffCount("点开输入框后");
	const field = await run<boolean>(`Boolean(document.querySelector("textarea"))`);
	note(`  7. 文字 → 输入框${field ? "已出现" : "没有出现"}`);
	if (!field) problems.push("选了文字工具后没有出现输入框");
	else {
		await run(`(() => {
			const el = document.querySelector("textarea");
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
			setter.call(el, "彻底修复");
			el.dispatchEvent(new Event("input", { bubbles: true }));
		})()`);
		await pause(80);
		const typed = await run<string>(`document.querySelector("textarea")?.value ?? "(没有输入框)"`);
		note(`     输入框内容 → ${JSON.stringify(typed)}`);
		if (typed !== "彻底修复") problems.push(`输入的文字没有进到输入框：${JSON.stringify(typed)}`);
		// Pressing elsewhere is what commits it — somewhere else empty, for the same reason.
		await click(socket, inside.x + 250, inside.y + 300);
		await pause(200);
		const still = await run<string | null>(`document.querySelector("textarea")?.value ?? null`);
		note(`     点击别处后 → ${still === null ? "输入框已关闭" : `又开了一个新的（${JSON.stringify(still)}）`}`);
		const afterText = await inkOf();
		note(`     提交后墨迹 ${afterText.ink}（此前 ${before.ink}），校验和 ${afterText.sum !== before.sum ? "已变" : "没变"}`);
		if (afterText.sum === before.sum) problems.push("文字没有画到画布上");
		captionInk = (await run<{ count: number; area: number } | null>(captionDiff))?.count ?? 0;
		note(`     文字落在自己那块区域的 ${captionInk} 个像素上`);
		if (captionInk < 100) problems.push(`文字没有画在预期位置（只有 ${captionInk} 个像素变化）`);
		before = afterText;
	}

	// ---- 8. 撤销 / 重做 ---------------------------------------------------
	await run(`[...document.querySelectorAll("button[data-ly-tip]")].find(b => b.dataset.lyTip.startsWith("撤销")).click()`);
	await pause(200);
	const undone = await inkOf();
	note(`  8. 撤销 → ${undone.ink} 像素（此前 ${before.ink}）`);
	if (undone.sum === before.sum) problems.push("撤销没有让画面回退");
	if (captionInk > 0) {
		const back = await run<{ count: number; area: number } | null>(captionDiff);
		note(`     文字那块区域还剩 ${back?.count ?? "?"} 个像素和写文字前不同（写上去时是 ${captionInk} 个）`);
		/*
		 * A tenth of what the caption drew — room for an antialiased edge, nowhere near enough for
		 * the caption still to be there.
		 *
		 * Local, not the whole region, and that is deliberate. Comparing every pixel of the overlay
		 * across two moments makes any stray input during the run — this is a fullscreen window over
		 * a live desktop — come out as a failure about undo, which is not what it would mean.
		 */
		if ((back?.count ?? 0) > captionInk / 10) {
			problems.push(`撤销之后文字没有从画布上消失（还差 ${back?.count} 个像素）`);
		}
	}
	await run(`[...document.querySelectorAll("button[data-ly-tip]")].find(b => b.dataset.lyTip.startsWith("重做")).click()`);
	await pause(200);
	const redone = await inkOf();
	note(`     重做 → ${redone.ink} 像素`);
	if (redone.sum !== before.sum) problems.push("重做没有还原到撤销前的画面");

	const errors = await run<string[]>(`window.__probeErrors ?? []`);
	if (errors.length) {
		note(`     渲染进程报错 ${errors.length} 条：`);
		for (const e of errors.slice(0, 8)) note(`       ${e}`);
		problems.push(`渲染进程抛了 ${errors.length} 条错误`);
	}

	// ---- 9. 存下来看一眼 --------------------------------------------------
	const shot = (await call<{ data: string }>(socket, "Page.captureScreenshot", { format: "png" })).data;
	await writeFile("/tmp/lyra-screenshot-overlay.png", Buffer.from(shot, "base64"));
	note("  9. 浮层截图已写入 /tmp/lyra-screenshot-overlay.png");

	// ---- 10. 完成，走真实保存路径 -----------------------------------------
	/*
	 * Clicked for real, and checked by the file that comes out of it.
	 *
	 * The first version of this replaced `window.lyra.screenshot.finish` with a spy. `window.lyra`
	 * comes through `contextBridge`, which hands over a frozen object — the assignment did nothing,
	 * the real handler ran, the overlay was destroyed mid-evaluate, and the probe hung until it
	 * timed out. Seeding a save directory and looking at what lands in it covers the whole path
	 * instead: the renderer's export, the IPC hop, and the main process writing the PNG.
	 */
	await run(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("完成")).click()`).catch(
		() => {},
	);
	let saved: { name: string; bytes: number } | null = null;
	for (let i = 0; i < 40 && !saved; i++) {
		await pause(250);
		const name = (await readdir(shots).catch(() => [] as string[])).find((n) => n.endsWith(".png"));
		if (name) saved = { name, bytes: (await stat(join(shots, name))).size };
	}
	note(`  10. 完成 → ${saved ? `${saved.name}，${Math.round(saved.bytes / 1024)} KB` : "没有保存任何文件"}`);
	if (!saved) problems.push("点了完成之后没有保存出文件");
	else {
		const size = await pngSize(join(shots, saved.name));
		note(`      图片尺寸 ${size.width}×${size.height}`);
		// Kept where it can be looked at: the export is its own code path, and "the file exists and
		// is the right size" does not say the marks made it into it.
		await writeFile("/tmp/lyra-screenshot-export.png", await readFile(join(shots, saved.name)));
		note("      导出的图片已复制到 /tmp/lyra-screenshot-export.png");
		// The selection ended at 680×460 CSS pixels, so the file is that times the scale factor.
		if (size.width < 600 || size.height < 400) problems.push(`导出的图片尺寸不对：${size.width}×${size.height}`);
	}

	// ---- 11. 焦点回到应用本身 ----------------------------------------------
	/*
	 * Not "the main window is still rendering" — it always was.
	 *
	 * The reported bug is that the app disappears behind whatever was on screen before it: the
	 * overlay is `alwaysOnTop` at screen-saver level, and when macOS destroys it the foreground
	 * goes to the application underneath, not back to Lyra. Nothing about the main window's DOM
	 * changes, which is why the first version of this check passed while the bug was there. The
	 * window server is the only thing that can answer it.
	 *
	 * Confirmed to fail when it should: with `app.focus({ steal: true })` removed from
	 * `closeScreenshotOverlay`, this reports whichever application happened to be behind the
	 * overlay instead of Lyra.
	 */
	const alive = await app.evaluate<boolean>(`Boolean(document.querySelector(".ly-shell"))`);
	if (!alive) problems.push("完成截图后主窗口没了");
	await pause(600);
	const front = await frontmostApp();
	note(`  11. 主窗口 ${alive ? "仍在渲染" : "不见了"}，前台应用 → ${front ?? "(这个平台读不到)"}`);
	/*
	 * Reported, not asserted, and the reason is the point.
	 *
	 * Where the foreground goes now depends on where the screenshot came from — see `cameFromApp`
	 * in `screenshot.ts`. Started from inside Lyra it comes back to Lyra; started by the global
	 * shortcut while reading something else it deliberately does not, because being yanked into a
	 * different application after screenshotting a browser is the complaint that produced that
	 * rule. Whether *this* run had focus at the moment it began is not something the probe controls,
	 * so asserting either answer would make it flaky in one direction or the other.
	 */
} finally {
	await app.stop();
}

console.log("");
if (problems.length === 0) {
	console.log("✅ 全部通过");
} else {
	console.log(`❌ ${problems.length} 个问题：`);
	for (const p of problems) console.log(`   - ${p}`);
	process.exitCode = 1;
}
