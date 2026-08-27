/**
 * The files a build needs, checked against git rather than against the disk.
 *
 * These are inputs — the app icon, the tray icons, the entitlements — and every one of them lived
 * only on the machine that made it: `.gitignore` had a `build/` rule meant for compiled output,
 * and this directory is called `build` while containing nothing of the sort. So the repository CI
 * checked out did not have them, electron-builder could not find the icon, and it fell back to
 * Electron's own atom without a word of complaint. Every release carried the wrong icon.
 *
 * The reason it survived is the shape of the mistake: the files are present on any machine that
 * has ever run the app, so building locally always looked right. Local verification could not
 * catch it — only asking git could.
 *
 * `git ls-files`, therefore, not `existsSync`. The question is not "is this file here", it is "is
 * this file in the repository", and those differ exactly when it matters.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { test } from "node:test";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));

/** Everything git knows about under `build/`, as paths relative to the desktop package. */
function tracked(): string[] {
	const out = execFileSync("git", ["ls-files", "build"], { cwd: desktop, encoding: "utf8" });
	return out.split("\n").filter(Boolean);
}

test("the app icon is in the repository, not just on this machine", () => {
	const files = tracked();
	// Named individually: electron-builder reads these by path, and a missing one is silent.
	assert.ok(files.includes("build/icon.icns"), "macOS 的图标不在仓库里");
	assert.ok(files.includes("build/icon.png"), "Linux 和 Windows 的图标不在仓库里");
});

test("the entitlements are too — an unsigned build is one thing, an unfindable plist is another", () => {
	assert.ok(tracked().includes("build/entitlements.mac.plist"));
});

test("the tray icons are, and all of them: the app loads these by path at runtime", () => {
	const files = tracked();
	const wanted = [
		"build/tray/trayTemplate.png",
		"build/tray/trayTemplate@2x.png",
		// Windows and Linux, in colour. The scaled copies are not decoration: 125% and 150% are the
		// commonest display scalings on Windows, and without a bitmap made at that size the system
		// resamples one of the others to get there.
		"build/tray/tray.png",
		"build/tray/tray@1.25x.png",
		"build/tray/tray@1.5x.png",
		"build/tray/tray@2x.png",
	];
	for (const file of wanted) assert.ok(files.includes(file), `${file} 不在仓库里`);
});

test("nothing under build/ is ignored, whatever a future rule says", () => {
	/*
	 * The guard against this happening again by a different route.
	 *
	 * `check-ignore` exits 1 when nothing matches, which is the answer we want; anything it does
	 * name is a file a build needs and a checkout would not have.
	 */
	let ignored = "";
	try {
		ignored = execFileSync("git", ["check-ignore", "build/icon.icns", "build/icon.png", "build/tray"], {
			cwd: desktop,
			encoding: "utf8",
		});
	} catch {
		// Exit 1: nothing is ignored. That is the passing case.
	}
	assert.equal(ignored.trim(), "", `这些构建资源被 .gitignore 挡住了：\n${ignored}`);
});
