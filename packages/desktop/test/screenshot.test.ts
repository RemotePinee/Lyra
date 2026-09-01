import test from "node:test";
import assert from "node:assert/strict";
import { resolveSaveDirectory } from "../electron/screenshot-path.ts";
import {
	applyThemeToWindows,
	findScreenshotReturnWindow,
	isScreenshotWindow,
	markScreenshotWindow,
	ScreenshotRendererGate,
	shouldApplyWindowTheme,
} from "../electron/screenshot-window.ts";
import { hwndFromNativeHandle, isIgnoredWindowClass, readNullTerminatedUtf16, sameBounds } from "../electron/window-detect.ts";
import { homedir } from "node:os";
import { join } from "node:path";

test("resolveSaveDirectory expands home dir when ~ prefix is used", () => {
	const res = resolveSaveDirectory("~/Pictures/Screenshots");
	assert.equal(res, join(homedir(), "Pictures/Screenshots"));
});

test("resolveSaveDirectory keeps absolute paths", () => {
	const res = resolveSaveDirectory("/tmp/screenshots");
	assert.equal(res, "/tmp/screenshots");
});

test("hwndFromNativeHandle reads 32-bit and 64-bit HWND buffers", () => {
	const hwnd32 = Buffer.alloc(4);
	hwnd32.writeUInt32LE(0x00a1b2c3, 0);
	assert.equal(hwndFromNativeHandle(hwnd32), 0x00a1b2c3n);

	const hwnd64 = Buffer.alloc(8);
	hwnd64.writeBigUInt64LE(0x00000001_00a1b2c3n, 0);
	assert.equal(hwndFromNativeHandle(hwnd64), 0x00000001_00a1b2c3n);

	assert.equal(hwndFromNativeHandle(Buffer.alloc(0)), 0n);
});

test("desktop chrome window classes are ignored for hover-snap", () => {
	assert.equal(isIgnoredWindowClass("Progman"), true);
	assert.equal(isIgnoredWindowClass("Shell_TrayWnd"), true);
	assert.equal(isIgnoredWindowClass("Chrome_WidgetWin_1"), false);
});

test("Win32 titles stop at an aligned UTF-16 NUL instead of the first zero byte", () => {
	const encoded = Buffer.alloc(64);
	encoded.write("Chrome_WidgetWin_1\0ignored", "utf16le");
	assert.equal(readNullTerminatedUtf16(encoded), "Chrome_WidgetWin_1");

	const chinese = Buffer.alloc(64);
	chinese.write("活动窗口\0ignored", "utf16le");
	assert.equal(readNullTerminatedUtf16(chinese), "活动窗口");
});

test("sameBounds allows a few pixels of slack and no more", () => {
	const a = { x: 10, y: 20, width: 800, height: 600 };
	assert.equal(sameBounds(a, { ...a, x: 12 }), true);
	assert.equal(sameBounds(a, { ...a, x: 20 }), false);
});

test("application theme updates never paint a screenshot window backing store", () => {
	const overlay = markScreenshotWindow({ name: "overlay", isDestroyed: () => false });
	const main = { name: "main", isDestroyed: () => false };
	const destroyed = { name: "destroyed", isDestroyed: () => true };

	assert.equal(isScreenshotWindow(overlay), true);
	assert.equal(isScreenshotWindow(main), false);
	assert.equal(shouldApplyWindowTheme(overlay), false);
	assert.equal(shouldApplyWindowTheme(main), true);
	assert.equal(shouldApplyWindowTheme(destroyed), false);
});

test("theme broadcast skips screenshot and destroyed windows in the real loop", () => {
	const calls: string[] = [];
	const windowState = (name: string, destroyed = false) => ({
		isDestroyed: () => destroyed,
		setBackgroundColor: (color: string) => calls.push(`${name}:background:${color}`),
		setTitleBarOverlay: ({ color }: { color: string }) => calls.push(`${name}:titlebar:${color}`),
	});
	const overlay = markScreenshotWindow(windowState("overlay"));
	const main = windowState("main");
	const destroyed = windowState("destroyed", true);

	applyThemeToWindows([overlay, main, destroyed], { color: "#fff", symbolColor: "#000" }, true);

	assert.deepEqual(calls, ["main:background:#fff", "main:titlebar:#fff"]);
});

test("screenshot return window excludes active and prewarmed overlays", () => {
	const windowState = (name: string, destroyed = false) => ({
		name,
		isDestroyed: () => destroyed,
	});
	const active = windowState("active overlay");
	const prewarmed = windowState("prewarmed overlay");
	const destroyed = windowState("destroyed", true);
	const main = windowState("main");

	assert.equal(
		findScreenshotReturnWindow([active, prewarmed, destroyed, main], [active], prewarmed),
		main,
	);
	assert.equal(findScreenshotReturnWindow([active, prewarmed], [active], prewarmed), undefined);
});

test("prewarmed renderer readiness survives until the first screenshot session", () => {
	const gate = new ScreenshotRendererGate();
	let reveals = 0;

	gate.markReady(7);
	gate.whenReady(7, () => reveals++);

	assert.equal(reveals, 1);
});

test("a screenshot waits for a renderer that has not mounted yet", () => {
	const gate = new ScreenshotRendererGate();
	let reveals = 0;

	gate.whenReady(7, () => reveals++);
	assert.equal(reveals, 0);
	gate.markReady(7);
	assert.equal(reveals, 1);
});
