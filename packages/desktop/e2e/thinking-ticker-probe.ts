/**
 * The thinking line while reasoning streams, and after: that it ticks, fades, rests at its
 * start, reads back on hover and unfolds beneath itself on click — with no heading and no chevron.
 *
 * `node --experimental-strip-types e2e/thinking-ticker-probe.ts`
 *
 * A scripted model streams one thinking block a few characters at a time and then holds the
 * stream open, so the line can be measured while it is being written; `/finish` on the model
 * ends the turn so the finished state can be measured too. Numbers rather than looks: the
 * track's transform against the width it does not fit, the mask's depths, the gap between two
 * runs, and two transforms a second apart for the read-back.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { startApp } from "./app.ts";

const MODEL_PORT = 9571;
const OUT = "/tmp/lyra-thinking-probe";
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, passed: boolean, evidence: string): void {
	if (!passed) failures++;
	process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n    ${evidence}\n`);
}

const REASONING = [
	"我需要先弄清楚这批未提交的改动都涉及哪些功能，再决定版本号该怎么升。",
	"1. 通读 core 里 provider 相关的 diff，看 **thinking** 选项是怎么被抽出去的",
	"2. 桌面端的 git 面板改了历史视图和文件 diff 列表，需要在真窗口里核对一遍",
	"3. 截图标注工具的命中测试有新的单测，说明 `annotate.ts` 的几何计算被重写过",
	"综合来看这是一个 minor 版本，release notes 要按功能分组来写。",
].join("\n");

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Where the stream is, from the outside: written by the model, read by the probe. */
const stream = { finish: null as (() => void) | null, finished: false, sentAll: false };

function startModel(): Server {
	const server = createServer((req, res) => {
		if (req.url === "/finish") {
			stream.finish?.();
			res.end("ok");
			return;
		}
		req.resume();
		req.on("end", async () => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const done = new Promise<void>((resolve) => {
				stream.finish = () => {
					stream.finished = true;
					resolve();
				};
			});
			sse(res, {
				type: "message_start",
				message: { id: "msg_1", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } },
			});
			sse(res, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
			let sent = 0;
			while (sent < REASONING.length && !stream.finished) {
				const piece = REASONING.slice(sent, sent + 5);
				sent += piece.length;
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: piece } });
				await settle(90);
			}
			stream.sentAll = true;
			await done;
			sse(res, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
			sse(res, { type: "content_block_stop", index: 0 });
			sse(res, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
			sse(res, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "看完了，可以发。" } });
			sse(res, { type: "content_block_stop", index: 1 });
			sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } });
			sse(res, { type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "one.ts"), "export const one = 1\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [
				{
					id: "local",
					name: "Local",
					baseUrl: `http://127.0.0.1:${MODEL_PORT}`,
					api: "anthropic-messages",
					apiKey: "not-a-key",
					enabled: true,
					models: [
						{
							id: "local/scripted",
							providerId: "local",
							modelId: "scripted",
							name: "Scripted",
							contextWindow: 200000,
							maxOutputTokens: 8192,
							supportsThinking: true,
							supportsImages: false,
							supportsTools: true,
						},
					],
				},
			],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "local/scripted",
			permissionMode: "full",
			thinking: "medium",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			sync: { enabled: false, port: 4521, token: null },
			appearance: { theme: "dark" },
		}),
	);
}

interface Reading {
	boxWidth: number;
	trackWidth: number;
	tx: number;
	fadeLeft: string;
	fadeRight: string;
	mask: string;
	runs: number;
	gaps: number[];
	chars: number;
	boxRight: number;
	mainRight: number;
}

/** Everything measurable about the live ticker, read off the DOM in one go. */
const READ = `(() => {
	const box = document.querySelector("main [data-ly-thinking] .ly-think-ticker");
	if (!box) return null;
	const track = box.firstElementChild;
	const runs = Array.from(track.querySelector(".ly-think-runs").children);
	const cs = getComputedStyle(track);
	const m = new DOMMatrixReadOnly(cs.transform === "none" ? "" : cs.transform);
	const bs = getComputedStyle(box);
	const rects = runs.map((r) => r.getBoundingClientRect());
	const gaps = rects.slice(1).map((r, i) => Math.round(r.left - rects[i].right));
	return {
		boxWidth: box.clientWidth,
		trackWidth: track.offsetWidth,
		tx: Math.round(m.e * 10) / 10,
		fadeLeft: bs.getPropertyValue("--ly-fade-left").trim(),
		fadeRight: bs.getPropertyValue("--ly-fade-right").trim(),
		mask: (bs.maskImage || bs.webkitMaskImage || "").slice(0, 40),
		runs: runs.length,
		gaps,
		chars: box.textContent.length,
		boxRight: Math.round(box.getBoundingClientRect().right),
		mainRight: Math.round(document.querySelector("main").getBoundingClientRect().right),
	};
})()`;

interface Loop {
	marquee: boolean;
	copies: number;
	tx: number;
	width: number;
	fadeEdge: boolean;
	fadeLeft: string;
	fadeRight: string;
	text: string;
}

/** The finished line's ticker, at rest or reading back. */
const READ_LOOP = `(() => {
	const box = document.querySelector("main [data-ly-thinking] .ly-think-ticker");
	if (!box) return null;
	const track = box.firstElementChild;
	const cs = getComputedStyle(track);
	const m = new DOMMatrixReadOnly(cs.transform === "none" ? "" : cs.transform);
	const bs = getComputedStyle(box);
	return {
		marquee: track.classList.contains("ly-marquee-track"),
		copies: track.children.length,
		tx: Math.round(m.e * 10) / 10,
		width: box.clientWidth,
		fadeEdge: box.classList.contains("ly-fade-edge"),
		fadeLeft: bs.getPropertyValue("--ly-fade-left").trim(),
		fadeRight: bs.getPropertyValue("--ly-fade-right").trim(),
		text: box.textContent.slice(0, 12),
	};
})()`;

/** What the line says about itself: whether any heading or chevron crept back in. */
const READ_CHROME = `(() => {
	const b = document.querySelector("main [data-ly-thinking]");
	if (!b) return null;
	return {
		heading: b.innerText.includes("思考过程"),
		chevron: Boolean(b.querySelector("svg.lucide-chevron-right")),
		brain: Boolean(b.querySelector("svg.lucide-brain")),
		follow: Boolean(b.querySelector(".ly-think-track")),
		runs: Boolean(b.querySelector(".ly-think-runs")),
		unfolded: Boolean(b.querySelector('button[aria-expanded="true"]')),
		body: (b.querySelector(".border-l-2")?.innerText ?? "").length,
		textLen: b.innerText.length,
		reply: document.querySelector("main").innerText.includes("看完了"),
	};
})()`;

interface Chrome {
	heading: boolean;
	chevron: boolean;
	brain: boolean;
	follow: boolean;
	runs: boolean;
	unfolded: boolean;
	body: number;
	textLen: number;
	reply: boolean;
}

await mkdir(OUT, { recursive: true });
const model = startModel();
const app = await startApp({ port: 9463, seed });

async function ask(text: string): Promise<void> {
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, ${JSON.stringify(text)});
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		return true;
	})()`);
}

/** A point near the line's left end — on the icon and the first words, whatever the ticker is doing. */
async function lineAt(): Promise<{ x: number; y: number }> {
	return app.evaluate<{ x: number; y: number }>(`(() => {
		const r = document.querySelector("main [data-ly-thinking] button").getBoundingClientRect();
		return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) };
	})()`);
}

async function moveTo(at: { x: number; y: number }): Promise<void> {
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
}

async function click(at: { x: number; y: number }): Promise<void> {
	await moveTo(at);
	await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
	await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
}

async function shot(name: string): Promise<void> {
	const png = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT, name), Buffer.from(png.data, "base64"));
}

/** Somewhere in the transcript that is not the line, for the pointer to rest between checks. */
const AWAY = { x: 640, y: 520 };

try {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await settle(600);
	await ask("看看这批改动");

	let there = false;
	for (let i = 0; i < 40 && !there; i++) {
		there = await app.evaluate<boolean>(`Boolean(document.querySelector("main [data-ly-thinking] .ly-think-ticker"))`);
		if (!there) await settle(250);
	}
	check("吐思考时那一行就是滚动的思考内容", there, there ? "找到 .ly-think-ticker" : "没等到 ticker");

	/* ---------- while it streams ---------- */
	const samples: Reading[] = [];
	for (let i = 0; i < 8; i++) {
		const reading = await app.evaluate<Reading | null>(READ);
		if (reading) samples.push(reading);
		await settle(350);
	}
	const chars = samples.map((s) => s.chars);
	check(
		"文字随流式增长",
		samples.length > 2 && chars.every((c, i) => i === 0 || c >= chars[i - 1]) && chars[chars.length - 1] > chars[0],
		`字数序列 ${chars.join(" → ")}`,
	);
	const fitting = samples.filter((s) => s.trackWidth <= s.boxWidth);
	const overflowing = samples.filter((s) => s.trackWidth > s.boxWidth);
	check(
		"未溢出时没有渐变，文字从左边开始",
		fitting.every((s) => s.fadeLeft === "0px" && s.tx === 0),
		`${fitting.length} 个样本 ${fitting.map((s) => `${s.fadeLeft}/${s.tx}`).join(" ")}`,
	);
	check(
		"溢出后向左滚，末尾贴着右边",
		overflowing.length > 0 && overflowing.every((s) => s.tx < 0),
		`${overflowing.length} 个溢出样本 tx=${overflowing.map((s) => s.tx).join(" ")}`,
	);
	check(
		"只朝一个方向滚",
		overflowing.every((s, i) => i === 0 || s.tx <= overflowing[i - 1].tx + 0.5),
		`tx 序列 ${overflowing.map((s) => s.tx).join(" → ")}`,
	);
	check(
		"溢出后左右都有渐变遮罩",
		overflowing.every((s) => s.fadeLeft === "24px" && s.fadeRight === "24px" && s.mask.startsWith("linear-gradient")),
		overflowing.map((s) => `${s.fadeLeft}/${s.fadeRight} ${s.mask}`).slice(-1).join(""),
	);
	check("滚动条宽度不超过 480", samples.every((s) => s.boxWidth <= 480), `最宽 ${Math.max(...samples.map((s) => s.boxWidth))}`);
	const chromeLive = await app.evaluate<Chrome>(READ_CHROME);
	check(
		"行上只有图标和内容：没有「思考过程」字样，没有箭头",
		chromeLive.brain && !chromeLive.heading && !chromeLive.chevron,
		JSON.stringify(chromeLive),
	);
	await shot("01-streaming.png");

	/* ---------- once the text has all arrived (stream still open) ---------- */
	for (let i = 0; i < 80 && !stream.sentAll; i++) await settle(250);
	await settle(700);
	const rest = await app.evaluate<Reading>(READ);
	check(
		"停下时末尾正好贴着右边缘",
		Math.abs(-rest.tx - (rest.trackWidth - rest.boxWidth)) <= 1,
		`tx=${rest.tx} track=${rest.trackWidth} box=${rest.boxWidth}`,
	);
	check("换行处的间隔是 28px", rest.runs >= 2 && rest.gaps.every((g) => g === 28), `${rest.runs} 段，间隔 ${rest.gaps.join(",")}`);
	check("整条不越出转录列", rest.boxRight <= rest.mainRight, `right=${rest.boxRight} main.right=${rest.mainRight}`);

	/* ---------- hover while streaming: same line, nothing else ---------- */
	const at = await lineAt();
	await moveTo(at);
	await settle(700);
	const hovered = await app.evaluate<{ follow: boolean; loop: boolean; extra: number }>(`(() => ({
		follow: Boolean(document.querySelector("main [data-ly-thinking] .ly-think-track")),
		loop: Boolean(document.querySelector("main [data-ly-thinking] .ly-marquee-track")),
		extra: document.querySelectorAll("[data-ly-thinking-peek], .ly-tooltip:not([hidden])").length,
	}))()`);
	check("吐出中悬停不改变形态、不弹别的东西", hovered.follow && !hovered.loop && hovered.extra === 0, JSON.stringify(hovered));

	/* ---------- click: the whole text unfolds beneath the line, which stays as it is ---------- */
	await click(at);
	await settle(400);
	const opened = await app.evaluate<Chrome>(READ_CHROME);
	check(
		"点击展开：全文在行下方带左边线出现，行本身不变，仍无标题和箭头",
		opened.unfolded && opened.body > 100 && opened.follow && !opened.heading && !opened.chevron && opened.brain,
		JSON.stringify(opened),
	);
	await shot("02-unfolded.png");

	await click(at);
	await settle(400);
	const refolded = await app.evaluate<Chrome>(READ_CHROME);
	check("再点一下收起", !refolded.unfolded && refolded.body === 0 && refolded.follow, JSON.stringify(refolded));

	/* ---------- finish the turn ---------- */
	await moveTo(AWAY);
	await settle(300);
	await fetch(`http://127.0.0.1:${MODEL_PORT}/finish`);
	await settle(1500);
	const finished = await app.evaluate<Chrome>(READ_CHROME);
	const resting = await app.evaluate<Loop | null>(READ_LOOP);
	check(
		"思考结束后那一行停在开头，还是没有「思考过程」和箭头",
		finished.brain && !finished.heading && !finished.chevron && !finished.follow && finished.runs && finished.reply,
		JSON.stringify(finished),
	);
	check(
		"停着时不动：右边渐隐说明还有，左边不遮",
		Boolean(resting && resting.tx === 0 && resting.fadeEdge && resting.fadeRight === "22px" && resting.fadeLeft === "0px" && resting.width <= 480),
		JSON.stringify(resting),
	);
	await shot("03-finished-rest.png");

	/* ---------- hover after finishing: reads back along the line ---------- */
	const at2 = await lineAt();
	await moveTo(at2);
	await settle(600);
	const loopA = await app.evaluate<Loop | null>(READ_LOOP);
	await settle(1000);
	const loopB = await app.evaluate<Loop | null>(READ_LOOP);
	check(
		"悬停时思考内容在行内读回",
		Boolean(loopA && loopA.marquee && loopA.copies === 2 && loopA.width <= 480),
		JSON.stringify(loopA),
	);
	check(
		"读回是在动的，且两端有渐变",
		Boolean(loopA && loopB && loopB.tx < loopA.tx - 5 && loopB.fadeLeft === "13px" && loopB.fadeRight === "22px"),
		`tx ${loopA?.tx} → ${loopB?.tx}，fade ${loopB?.fadeLeft}/${loopB?.fadeRight}`,
	);
	await shot("04-hover-finished.png");

	await moveTo(AWAY);
	await settle(500);
	const back = await app.evaluate<Loop | null>(READ_LOOP);
	check("鼠标移开，回到开头停住", Boolean(back && back.tx === 0 && back.fadeLeft === "0px"), JSON.stringify(back));
} finally {
	stream.finish?.();
	await app.stop();
	await new Promise((resolve) => model.close(() => resolve(null)));
}

process.stdout.write(`\n${failures === 0 ? "全部通过" : `${failures} 项未通过`}，截图在 ${OUT}\n`);
process.exit(failures === 0 ? 0 : 1);
