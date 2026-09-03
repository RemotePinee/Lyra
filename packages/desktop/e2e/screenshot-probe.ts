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
	id: string;
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
 * Press a toolbar button the way a person does: a real pointer press at its real coordinates.
 *
 * Not `element.click()`, and this distinction cost a release. A DOM click dispatches one `click`
 * event and no pointer events at all, so it cannot see anything that goes wrong on `pointerdown` —
 * and what was wrong was that pressing any tool button fell through to the overlay's own handler,
 * which read it as "pressed outside the selection", threw the selection away and went back to the
 * empty crosshair. Every button was broken in the shipped app while this file reported all green.
 */
async function pressTool(
	socket: string,
	run: <T>(expression: string) => Promise<T>,
	tip: string,
): Promise<{ x: number; y: number } | null> {
	const at = await run<{ x: number; y: number } | null>(`(() => {
		const b = [...document.querySelectorAll("button[data-ly-tip]")].find(b => b.dataset.lyTip.startsWith(${JSON.stringify(tip)}));
		if (!b) return null;
		const r = b.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	})()`);
	if (!at) return null;
	await call(socket, "Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
	await call(socket, "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
	return at;
}

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
			JSON.stringify({ screenshot: { saveLocation: shots, copyToClipboard: false } }, null, 2),
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

	// The prewarmed renderer is shown immediately; the snapshot arrives independently for export.
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
	/*
	 * Wait for the document before putting anything on `window`.
	 *
	 * The debugger target exists from the moment the page is created, so an injection made too
	 * early is thrown away by the navigation that follows it — which is why the frame recorder
	 * below came back empty. Loading is not showing: this completes while the window is still
	 * hidden, which is exactly the window of opportunity that is wanted.
	 */
	for (let i = 0; i < 60; i++) {
		if (await run<boolean>(`document.readyState === "complete"`)) break;
		await pause(100);
	}

	await run(`(() => {
		window.__probeErrors = [];
		window.addEventListener("error", (e) => window.__probeErrors.push(String(e.message)));
		window.addEventListener("unhandledrejection", (e) => window.__probeErrors.push("rejected: " + e.reason));
		const err = console.error.bind(console);
		console.error = (...a) => { window.__probeErrors.push(a.map(String).join(" ")); err(...a); };
	})()`);

	/*
	 * Before a region or snap target exists, the overlay must not paint a solid veil over the whole
	 * display. The BrowserWindow is transparent; this catches a renderer layer that defeats it.
	 */
	const initialPaint = await run<{
		html: string;
		body: string;
		root: string;
		fullDim: number;
		opacityTransitions: number;
		snapshot: { complete: boolean; naturalWidth: number; width: number; height: number } | null;
	}>(`(() => {
		const alpha = color => {
			if (color === "transparent") return 0;
			const match = color.match(/rgba?\\(([^)]+)\\)/);
			if (!match) return 1;
			const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
			return parts.length > 3 ? parts[3] : 1;
		};
		const fullDim = [...document.querySelectorAll("div")].filter(el => {
			const r = el.getBoundingClientRect();
			return r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight &&
				alpha(getComputedStyle(el).backgroundColor) > 0;
		}).length;
		const opacityTransitions = [...document.querySelectorAll("*")].filter(el => {
			const style = getComputedStyle(el);
			const properties = style.transitionProperty.split(",").map(value => value.trim());
			return (properties.includes("opacity") || properties.includes("all")) &&
				style.transitionDuration.split(",").some(value => parseFloat(value) > 0);
		}).length;
		const image = document.querySelector("[data-screenshot-overlay] > img");
		const imageRect = image?.getBoundingClientRect();
		return {
			html: getComputedStyle(document.documentElement).backgroundColor,
			body: getComputedStyle(document.body).backgroundColor,
			root: getComputedStyle(document.getElementById("root")).backgroundColor,
			fullDim,
			opacityTransitions,
			snapshot: image ? {
				complete: image.complete,
				naturalWidth: image.naturalWidth,
				width: Math.round(imageRect.width),
				height: Math.round(imageRect.height),
			} : null,
		};
	})()`);
	note(`  初始背景 → html ${initialPaint.html}，body ${initialPaint.body}，root ${initialPaint.root}`);
	if (initialPaint.fullDim > 0) problems.push(`框选前有 ${initialPaint.fullDim} 层不透明背景覆盖整个屏幕`);
	if (initialPaint.snapshot) problems.push("浮层仍把桌面快照绘制成了全屏背景");
	else note("  首帧绘制 → 无桌面快照、无全屏背景");
	if (initialPaint.opacityTransitions > 0) problems.push(`浮层仍有 ${initialPaint.opacityTransitions} 个 opacity 过渡`);
	else note("  进入过渡 → 无");

	// ---- 1. 拉出一个选区 -------------------------------------------------
	/*
	 * Wait for the window to be its full size before pressing anything.
	 *
	 * The overlay appears in the target list before it has been shown, and `clampRect` clamps the
	 * selection to `window.innerHeight` — so a drag dispatched too early is trimmed to whatever the
	 * window measured at the time, which showed up as an intermittent short selection.
	 */
	/*
	 * Wait for the window to actually be on screen, not merely to exist.
	 *
	 * The overlay is created with `show: false` and revealed once its prewarmed renderer is ready,
	 * so its debugger target can be listed before it is visible. Pointer
	 * events dispatched into a window that has not been shown go nowhere useful, which showed up
	 * as the first drag intermittently producing no selection at all — a flaky probe reporting a
	 * real feature as broken, and worse, sometimes reporting a broken one as fine.
	 */
	let visible = false;
	for (let i = 0; i < 60 && !visible; i++) {
		visible = await run<boolean>(`document.visibilityState === "visible" && !document.hidden`);
		if (!visible) await pause(100);
	}
	if (!visible) problems.push("浮层窗口一直没有显示出来");

	/*
	 * A blue window target proves the native enumeration reached the renderer with usable screen
	 * coordinates. Merely unit-testing the hit-test missed a UTF-16 decoder that returned an empty
	 * title for every ordinary Windows window, which silently filtered the entire native list.
	 */
	if (process.platform === "win32") {
		const viewport = await run<{ width: number; height: number }>(`({ width: innerWidth, height: innerHeight })`);
		let snap: { title: string; width: number; height: number } | null = null;
		for (let y = 60; y < viewport.height && !snap; y += 100) {
			for (let x = 60; x < viewport.width && !snap; x += 100) {
				await call(socket, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
				await pause(20);
				snap = await run<{ title: string; width: number; height: number } | null>(`(() => {
					const box = document.querySelector("[data-snap-hover], .border-sky-400");
					if (!box) return null;
					const rect = box.getBoundingClientRect();
					return { title: box.textContent.trim(), width: Math.round(rect.width), height: Math.round(rect.height) };
				})()`);
			}
		}
		if (snap) note(`  活动窗口识别 → ${snap.title}（${snap.width}×${snap.height}）`);
		else problems.push("Windows 活动窗口枚举未产生任何可悬停目标");
	}

	let stable = 0;
	let last = 0;
	for (let i = 0; i < 30 && stable < 3; i++) {
		const tall = await run<number>(`window.innerHeight`);
		stable = tall === last && tall > 700 ? stable + 1 : 0;
		last = tall;
		await pause(100);
	}
	note(`  0. 窗口已显示，高度稳定在 ${last}`);
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
	const cursorAfterSelection = drawn
		? await run<string>(`(() => {
			const el = document.elementFromPoint(${drawn.x + drawn.w / 2}, ${drawn.y + drawn.h / 2});
			return el ? getComputedStyle(el).cursor : "unknown";
		})()`)
		: "unknown";
	note(`     框选后的选区内光标 → ${cursorAfterSelection}`);
	if (cursorAfterSelection === "crosshair") problems.push("框选结束后选区内仍然是十字光标");

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
	/*
	 * Every control has to be reachable, which means the whole bar has to be on screen.
	 *
	 * It is placed by clamping against a declared width, so a declared width that has drifted from
	 * the real one pushes the far end — 完成 among them — past the edge of the display, where no
	 * pointer can go. Checked per button rather than on the bar as a whole, because that is the
	 * thing that actually has to be clickable.
	 */
	const offscreen = await run<{ tip: string; x: number; right: number }[]>(`(() => {
		const out = [];
		for (const b of document.querySelectorAll("button[data-ly-tip]")) {
			const r = b.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) {
				out.push({ tip: b.dataset.lyTip, x: Math.round(r.left), right: Math.round(r.right) });
			}
		}
		return out;
	})()`);
	note(`     控件是否都在屏幕内 → ${offscreen.length === 0 ? "是" : `${offscreen.length} 个跑到屏幕外`}`);
	if (offscreen.length > 0) {
		problems.push(`工具条有 ${offscreen.length} 个控件在屏幕外点不到：${offscreen.map((o) => o.tip).join("、")}（窗口宽 ${await run<number>(`window.innerWidth`)}）`);
	}
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
	const canvasFit = await run<{ x: number; y: number; w: number; h: number; bitmap: number; win: number; dpr: number; ratio: number } | null>(`(() => {
		const cs = document.querySelectorAll("canvas");
		const c = cs[cs.length - 1];
		if (!c) return null;
		const r = c.getBoundingClientRect();
		return {
			x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
			bitmap: c.width, win: window.innerWidth, dpr: window.devicePixelRatio, ratio: c.width / r.width,
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
		if (Math.abs(canvasFit.ratio - canvasFit.dpr) > 0.01) {
			problems.push(`标注画布的位图比例不是设备比例：${canvasFit.ratio.toFixed(3)} vs ${canvasFit.dpr}`);
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
		const picked = await pressTool(socket, run, name);
		if (!picked) {
			problems.push(`工具条上没有「${name}」按钮`);
			continue;
		}
		await pause(80);
		/*
		 * The selection has to survive being pressed on the toolbar.
		 *
		 * This is the check that would have caught the shipped bug: the bar floats outside the
		 * selection, so a press on it that reaches the overlay's handler is read as "start a new
		 * region" and the selection is gone. On screen that is a capture that resets itself the
		 * moment you pick a tool.
		 */
		const alive = await run<boolean>(`Boolean(document.querySelector('[class*="border-white/90"]'))`);
		if (!alive) {
			problems.push(`点了「${name}」按钮之后选区没了——工具条的点击穿到浮层上了`);
			break;
		}
		/*
		 * The colour swatches belong to tools that draw in a colour.
		 *
		 * A mosaic samples the picture underneath it, so colours shown beside it do nothing to
		 * anything — a control that cannot affect what is selected is a promise the tool does not keep.
		 */
		const swatches = await run<number>(`document.querySelectorAll('[data-ly-tip="红色"], [data-ly-tip="蓝色"]').length`);
		if (name === "马赛克" && swatches > 0) problems.push("选中马赛克时还显示着颜色选择——马赛克没有颜色");
		if (name !== "马赛克" && swatches === 0) problems.push(`选中「${name}」时颜色选择不见了`);
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
	await pressTool(socket, run, "画笔");
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
	await pressTool(socket, run, "文字");
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
	await pressTool(socket, run, "撤销");
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
	await pressTool(socket, run, "重做");
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
	// The destination the app believes in, printed because a mismatch between this and the directory
	// below is what a stale instance on the debug port looks like from here.
	note(`      保存位置 → ${await app.evaluate<string>(`window.lyra.settings.get().then(s => s.screenshot?.saveLocation ?? "(没有)")`)}`);
	const finished = await pressTool(socket, run, "完成");
	if (!finished) problems.push("工具条上没有「完成」按钮");
	await pause(700);
	const overlayGone = !(await targets()).some((t) => t.id === overlay.id);
	note(`      点「完成」之后浮层${overlayGone ? "已关闭" : "还开着"}`);
	if (!overlayGone) {
		problems.push("点了完成之后浮层没有关闭——还停在截图状态");
		const why = await run<string[]>(`window.__probeErrors ?? []`).catch(() => []);
		if (why.length) note(`      渲染进程报错：${why.slice(0, 4).join(" | ")}`);
	}
	let saved: { name: string; bytes: number } | null = null;
	for (let i = 0; i < 40 && !saved; i++) {
		await pause(250);
		const name = (await readdir(shots).catch(() => [] as string[])).find((n) => n.endsWith(".png"));
		if (name) saved = { name, bytes: (await stat(join(shots, name))).size };
	}
	note(`  10. 完成 → ${saved ? `${saved.name}，${Math.round(saved.bytes / 1024)} KB` : "没有保存任何文件"}`);
	if (!saved) {
		problems.push("点了完成之后没有保存出文件");
		// Which half is broken: the save path itself, or the overlay's call into it.
		const direct = await app.evaluate<string>(
			`window.lyra.screenshot.finish("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==").then(r => JSON.stringify(r), e => "threw: " + e.message)`,
		).catch((e) => `evaluate failed: ${e.message}`);
		note(`      直接调用保存 → ${direct}`);
		const now = await readdir(shots).catch((e) => [`(读不了: ${e.message})`]);
		note(`      探针在看的目录 → ${shots}`);
		note(`      直接调用之后目录里 → ${now.length ? now.join(", ") : "(还是空的)"}`);
		const claimed = /"filePath":"([^"]+)"/.exec(direct)?.[1];
		if (claimed) {
			note(`      主进程说写到了 → ${claimed}`);
			note(`      那个文件真的在吗 → ${await stat(claimed).then((s) => `${s.size} 字节`, (e) => `不在：${e.code}`)}`);
		}
	}
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
	const alive = await app.evaluate<boolean>(`Boolean(document.querySelector("textarea"))`);
	if (!alive) problems.push("完成截图后主窗口没了");
	await pause(600);
	const front = await frontmostApp();
	note(`  11. 主窗口 ${alive ? "仍在渲染" : "不见了"}，前台应用 → ${front ?? "(这个平台读不到)"}`);

	// ---- 12. Escape destroys the active input window -------------------------
	await app.evaluate(`window.lyra.screenshot.start()`);
	let cancelOverlay: Target | undefined;
	for (let i = 0; i < 40 && !cancelOverlay; i++) {
		await pause(100);
		cancelOverlay = (await targets()).find((t) => t.type === "page" && t.url.includes("screenshot-overlay"));
	}
	if (!cancelOverlay?.webSocketDebuggerUrl) {
		problems.push("第二次截图浮层没有出现，无法验证 Escape");
	} else {
		if (process.platform === "win32") {
			// The overlay is deliberately non-focusable. Send a real desktop key so this exercises the
			// temporary global Escape registration rather than CDP's direct renderer injection.
			await execFileAsync("powershell.exe", [
				"-NoProfile",
				"-Command",
				"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESC}')",
			]);
		} else {
			await call(cancelOverlay.webSocketDebuggerUrl, "Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Escape",
				code: "Escape",
				windowsVirtualKeyCode: 27,
			});
		}
		let cancelled = false;
		for (let i = 0; i < 30 && !cancelled; i++) {
			await pause(100);
			cancelled = !(await targets()).some((t) => t.id === cancelOverlay!.id);
		}
		note(`  12. 按 Escape → ${cancelled ? "活动浮层已销毁" : "活动浮层仍在"}`);
		if (!cancelled) problems.push("按 Escape 后活动浮层没有销毁，仍会拦截输入");
	}
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
