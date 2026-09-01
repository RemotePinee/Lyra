/**
 * Visible top-level windows on Windows, in Z-order, via user32/dwmapi.
 *
 * PowerShell + `Add-Type` recompiles a C# helper on every capture, which is hundreds of
 * milliseconds and the opposite of a hover-highlight. koffi is already a runtime dependency of
 * this app (the Windows sandbox); calling the same APIs in-process is the cheap path.
 *
 * Coordinates come back from DWM in physical pixels. Electron's overlay lives in DIP, so each
 * rect is converted with Electron's rectangle conversion relative to the display nearest that
 * window — a single scaleFactor is wrong on mixed-DPI setups.
 */

import { screen } from "electron";

import type { DetectedWindow } from "./window-detect.ts";
import { hwndFromNativeHandle, isIgnoredWindowClass, readNullTerminatedUtf16 } from "./window-detect.ts";

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GW_OWNER = 4;
const WS_CHILD = 0x40000000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const MIN_SIZE = 40;

interface Win32Api {
	enumWindows(cb: (hwnd: unknown) => boolean): void;
	isWindowVisible(hwnd: unknown): number;
	isIconic(hwnd: unknown): number;
	getWindow(hwnd: unknown, cmd: number): unknown;
	getClassName(hwnd: unknown): string;
	getWindowText(hwnd: unknown): string;
	getWindowLong(hwnd: unknown, index: number): bigint;
	getWindowRect(hwnd: unknown): { left: number; top: number; right: number; bottom: number } | null;
	dwmCloaked(hwnd: unknown): boolean;
	dwmFrame(hwnd: unknown): { left: number; top: number; right: number; bottom: number } | null;
}

let cached: Win32Api | null = null;

function loadApi(): Win32Api | null {
	if (cached) return cached;
	try {
		// Same lazy require as the sandbox: a static import would load a native .node on macOS.
		// oxlint-disable-next-line typescript/no-require-imports -- koffi is a native .node, loaded only on Windows
		const koffi = require("koffi") as typeof import("koffi");
		const PVOID = koffi.pointer("void");
		const user32 = koffi.load("user32.dll");
		const dwmapi = koffi.load("dwmapi.dll");
		const bind = (lib: ReturnType<typeof koffi.load>, name: string, result: unknown, args: unknown[]) =>
			// oxlint-disable-next-line typescript/no-explicit-any -- koffi func() is not typed
			(lib as any).func("__stdcall", name, result, args) as (...args: unknown[]) => unknown;

		const EnumWindowsProc = koffi.proto("int __stdcall EnumWindowsProc(void *hwnd, void *lParam)");
		const EnumWindows = bind(user32, "EnumWindows", "int", [koffi.pointer(EnumWindowsProc), PVOID]);
		const IsWindowVisible = bind(user32, "IsWindowVisible", "int", [PVOID]);
		const IsIconic = bind(user32, "IsIconic", "int", [PVOID]);
		const GetWindow = bind(user32, "GetWindow", PVOID, [PVOID, "uint32"]);
		const GetClassNameW = bind(user32, "GetClassNameW", "int", [PVOID, PVOID, "int"]);
		const GetWindowTextW = bind(user32, "GetWindowTextW", "int", [PVOID, PVOID, "int"]);
		const GetWindowRect = bind(user32, "GetWindowRect", "int", [PVOID, PVOID]);
		const GetWindowLongPtr = bind(
			user32,
			process.arch === "ia32" ? "GetWindowLongW" : "GetWindowLongPtrW",
			process.arch === "ia32" ? "int32" : "int64",
			[PVOID, "int"],
		);
		const DwmGetWindowAttribute = bind(dwmapi, "DwmGetWindowAttribute", "int", [PVOID, "uint32", PVOID, "uint32"]);

		const classBuf = Buffer.alloc(256 * 2);
		const titleBuf = Buffer.alloc(512 * 2);
		const rectBuf = Buffer.alloc(16);
		const intBuf = Buffer.alloc(4);

		const readRect = (buf: Buffer) => ({
			left: buf.readInt32LE(0),
			top: buf.readInt32LE(4),
			right: buf.readInt32LE(8),
			bottom: buf.readInt32LE(12),
		});

		cached = {
			enumWindows(cb) {
				const registered = koffi.register((hwnd: unknown) => (cb(hwnd) ? 1 : 0), koffi.pointer(EnumWindowsProc));
				try {
					EnumWindows(registered, null);
				} finally {
					koffi.unregister(registered);
				}
			},
			isWindowVisible: (hwnd) => IsWindowVisible(hwnd) as number,
			isIconic: (hwnd) => IsIconic(hwnd) as number,
			getWindow: (hwnd, cmd) => GetWindow(hwnd, cmd),
			getClassName(hwnd) {
				classBuf.fill(0);
				GetClassNameW(hwnd, classBuf, 256);
				return readNullTerminatedUtf16(classBuf);
			},
			getWindowText(hwnd) {
				titleBuf.fill(0);
				GetWindowTextW(hwnd, titleBuf, 512);
				return readNullTerminatedUtf16(titleBuf);
			},
			getWindowLong(hwnd, index) {
				const value = GetWindowLongPtr(hwnd, index);
				return typeof value === "bigint" ? value : BigInt(value as number);
			},
			getWindowRect(hwnd) {
				rectBuf.fill(0);
				if (!GetWindowRect(hwnd, rectBuf)) return null;
				return readRect(rectBuf);
			},
			dwmCloaked(hwnd) {
				intBuf.fill(0);
				if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, intBuf, 4) !== 0) return false;
				return intBuf.readInt32LE(0) !== 0;
			},
			dwmFrame(hwnd) {
				rectBuf.fill(0);
				if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rectBuf, 16) !== 0) return null;
				return readRect(rectBuf);
			},
		};
		return cached;
	} catch (err) {
		console.error("[screenshot] failed to bind window detection:", err);
		return null;
	}
}

function asHwnd(hwnd: unknown): bigint {
	if (typeof hwnd === "bigint") return hwnd;
	if (typeof hwnd === "number") return BigInt(hwnd);
	if (Buffer.isBuffer(hwnd)) return hwndFromNativeHandle(hwnd);
	return 0n;
}

function toDipRect(phys: { left: number; top: number; right: number; bottom: number }): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	const converted = screen.screenToDipRect(null, {
		x: phys.left,
		y: phys.top,
		width: phys.right - phys.left,
		height: phys.bottom - phys.top,
	});
	return {
		x: Math.round(converted.x),
		y: Math.round(converted.y),
		width: Math.round(converted.width),
		height: Math.round(converted.height),
	};
}

export function detectWindowsOnWin32(excludeHwnd?: bigint): DetectedWindow[] {
	const api = loadApi();
	if (!api) return [];

	const results: DetectedWindow[] = [];
	api.enumWindows((hwnd) => {
		try {
			if (excludeHwnd !== undefined && asHwnd(hwnd) === excludeHwnd) return true;
			if (!api.isWindowVisible(hwnd) || api.isIconic(hwnd)) return true;
			if (api.dwmCloaked(hwnd)) return true;

			const style = api.getWindowLong(hwnd, GWL_STYLE);
			const exStyle = api.getWindowLong(hwnd, GWL_EXSTYLE);
			if ((style & BigInt(WS_CHILD)) !== 0n) return true;
			if ((exStyle & BigInt(WS_EX_TOOLWINDOW)) !== 0n && (exStyle & BigInt(WS_EX_APPWINDOW)) === 0n) return true;

			const cls = api.getClassName(hwnd);
			if (isIgnoredWindowClass(cls)) return true;

			const owner = api.getWindow(hwnd, GW_OWNER);
			if (owner && asHwnd(owner) !== 0n && api.isWindowVisible(owner)) return true;

			const frame = api.dwmFrame(hwnd) ?? api.getWindowRect(hwnd);
			if (!frame) return true;
			const rect = toDipRect(frame);
			if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return true;

			const title = api.getWindowText(hwnd);
			if (!title) return true;

			results.push({ id: asHwnd(hwnd).toString(), title, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
		} catch {
			// One bad HWND must not abort the rest of the z-order walk.
		}
		return true;
	});
	return results;
}
