/**
 * The update badge and dialog, driven through a real download of the real release.
 *
 * Not a test — `node e2e/update-shot.ts` — and it is here rather than in `*.test.ts` because it
 * needs the network and a published release, which a test suite must not. What it is for is the
 * half of this feature that only exists once it is on screen: whether the ring actually closes,
 * whether pausing looks paused, whether closing the dialog leaves the badge still counting.
 *
 * It walks the phases in order and photographs each one, so the sequence can be reviewed as a
 * sequence. The caller is expected to have dropped `packages/desktop/package.json` to an older
 * version first — `app.getVersion()` reads that file, and an app that is already the latest
 * version has, correctly, nothing to show.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startApp } from "./app.ts";

const out = process.argv[2] ?? "/tmp/lyra-update";

async function seed(home: string): Promise<void> {
	await mkdir(home, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			pluginRegistries: [],
			skillRegistries: [],
			alwaysAllow: [],
			sync: { enabled: false, port: 4517, token: null },
			appearance: { theme: process.env.LYRA_SHOT_THEME === "light" ? "light" : "dark" },
		}),
	);
}

const app = await startApp({ port: 9452, seed });
const say = (message: string) => process.stdout.write(`${message}\n`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Crop to the sidebar's bottom corner, which is where the badge lives and all it needs to be seen. */
async function shot(name: string, full = false): Promise<void> {
	const clip = full ? undefined : { x: 0, y: 700, width: 340, height: 120, scale: 2 };
	const picture = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
	await writeFile(`${out}-${name}.png`, Buffer.from(picture.data, "base64"));
	say(`  → ${out}-${name}.png`);
}

/**
 * Put the badge into `:hover` and leave it there.
 *
 * `Input.dispatchMouseEvent` was the obvious way and it does not work: a synthetic move updates
 * where the page thinks the pointer is, but the *hover* that CSS matches on is decided by the
 * compositor from the real cursor, which is wherever the person running this left it. It appeared
 * to work when the badge was large enough to sit under the cursor by luck, and stopped the moment
 * it was made smaller — a test that passes because of where a mouse happens to be is worse than no
 * test.
 *
 * `CSS.forcePseudoState` is what the DevTools "force element state" checkbox does, and it asserts
 * the state directly. Verified afterwards rather than assumed, because a silently ineffective
 * hover produces two identical screenshots and a reviewer who concludes the animation is broken.
 */
async function hoverBadge(): Promise<void> {
	const box = await app.evaluate<{ x: number; y: number } | null>(`(() => {
		const badge = document.querySelector(".ly-update-dot");
		if (!badge) return null;
		const r = badge.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`);
	if (!box) throw new Error("没有找到更新按钮");
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, buttons: 0 });
	await wait(600);

	/*
	 * Checked, not assumed.
	 *
	 * A hover that silently fails to land produces two identical screenshots and a reviewer who
	 * concludes the animation is broken — which is exactly what happened once here, and cost a
	 * detour into `CSS.forcePseudoState` (which cannot work: `app.ts` opens a socket per call, and
	 * a `nodeId` belongs to the session that issued it).
	 */
	const open = await app.evaluate<{ hovered: boolean; label: number }>(`({
		hovered: Boolean(document.querySelector(".ly-update-dot:hover")),
		label: document.querySelector(".ly-update-version")?.getBoundingClientRect().width ?? 0,
	})`);
	if (!open.hovered || open.label < 4) throw new Error(`hover 没生效：${JSON.stringify(open)}`);
}

/** Move the pointer away, so the next photograph is of the resting state. */
async function unhoverBadge(): Promise<void> {
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300, buttons: 0 });
	await wait(500);
}

async function phase(): Promise<string> {
	return app.evaluate<string>(`window.lyra.updates.state().then((p) => JSON.stringify(p))`);
}

try {
	await wait(3500);
	const info = await app.evaluate<string>(`window.lyra.updates.check().then((i) => JSON.stringify(i))`);
	say(`检查更新：${info}`);
	if (!JSON.parse(info).available) throw new Error("没有可用更新——先把 package.json 的版本降下去");

	say("1. 静止：应当是一个圆点");
	await shot("1-dot");

	say("2. 悬停：横向展开，显示版本号");
	await hoverBadge();
	await shot("2-hover");
	await unhoverBadge();

	/*
	 * The screenshots below are taken on a short leash on purpose.
	 *
	 * 135MB arrives in about four seconds on this connection, so a comfortable `wait(4000)` before
	 * photographing "downloading" photographs a download that has already finished. Everything in
	 * this section is therefore measured in a few hundred milliseconds.
	 */
	say("3. 开始下载（真实的 135MB）");
	void app.evaluate(`window.lyra.updates.download(${JSON.stringify(JSON.parse(info).latest)})`);
	await wait(400);
	say(`   ${await phase()}`);
	await shot("3-downloading");
	await hoverBadge();
	await shot("3b-downloading-hover");
	await unhoverBadge();

	say("4. 暂停");
	await app.evaluate(`window.lyra.updates.pause()`);
	await wait(400);
	const paused = JSON.parse(await phase());
	say(`   ${JSON.stringify(paused)}`);
	if (paused.at !== "paused") throw new Error(`暂停之后应当是 paused，实际是 ${paused.at}`);
	await shot("4-paused");

	say("5. 打开弹窗看暂停态");
	await app.evaluate(`document.querySelector(".ly-update-dot").click()`);
	await wait(600);
	await shot("5-dialog-paused", true);

	say("6. 继续，然后马上关掉弹窗——下载应当照常进行");
	await app.evaluate(`(() => {
		const go = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("继续下载"));
		if (!go) throw new Error("没有找到继续下载按钮");
		go.click();
		return true;
	})()`);
	await wait(150);
	// Escape is the ordinary way out of a dialog, and the one the old version had to ignore.
	await app.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
	await wait(150);
	const closed = await app.evaluate<boolean>(`!document.body.innerText.includes("有新版本可以更新")`);
	say(`   弹窗关掉了：${closed}`);

	const before = JSON.parse(await phase());
	await wait(700);
	const after = JSON.parse(await phase());
	say(`   关窗后：${before.received} → ${after.received} 字节（${after.at}）`);
	const moved = after.at === "preparing" || after.at === "ready" || after.at === "failed" || after.received > before.received;
	if (!moved) throw new Error("关掉弹窗之后下载停了——这正是要修的那件事");
	say("   ✓ 关掉弹窗，下载照常进行");
	await shot("6-after-close");

	say("7. 走到底，看它怎么收场");
	await wait(6000);
	say(`   ${await phase()}`);
	await app.evaluate(`document.querySelector(".ly-update-dot")?.click()`);
	await wait(600);
	await shot("7-final-dialog", true);
} finally {
	await app.stop();
}
