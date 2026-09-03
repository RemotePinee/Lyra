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
import {
	hwndFromNativeHandle,
	isIgnoredWindowClass,
	physicalRectToDip,
	readNullTerminatedUtf16,
} from "./window-detect.ts";

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
	setWindowPos(
		hwnd: bigint | number,
		insertAfter: bigint | number,
		x: number,
		y: number,
		cx: number,
		cy: number,
		flags: number,
	): number;
	setForegroundWindow(hwnd: bigint | number): number;
	showWindow(hwnd: bigint | number, cmd: number): number;
	setCrosshairCursor(): void;
	setArrowCursor(): void;
	setThreadDpiAwareness(): void;
	captureScreen(
		x: number,
		y: number,
		width: number,
		height: number,
	): { pixels: Uint8Array; width: number; height: number } | null;
	getMonitorPhysicalRect(
		x: number,
		y: number,
	): { left: number; top: number; right: number; bottom: number } | null;
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
		const gdi32 = koffi.load("gdi32.dll");
		const dwmapi = koffi.load("dwmapi.dll");
		const bind = (lib: ReturnType<typeof koffi.load>, name: string, result: unknown, args: unknown[]) =>
			// oxlint-disable-next-line typescript/no-explicit-any -- koffi func() is not typed
			(lib as any).func("__stdcall", name, result, args) as (...args: unknown[]) => unknown;

		let setThreadDpiAwareness = () => {};
		try {
			const SetThreadDpiAwarenessContext = bind(user32, "SetThreadDpiAwarenessContext", PVOID, [PVOID]);
			setThreadDpiAwareness = () => {
				try {
					// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
					SetThreadDpiAwarenessContext(-4);
				} catch {
					// Per-Monitor V2 may not be supported on older builds
				}
			};
			setThreadDpiAwareness();
		} catch {
			// SetThreadDpiAwarenessContext unavailable
		}

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
		const HWND_ARG = process.arch === "ia32" ? "int32" : "int64";
		const SetWindowPos = bind(user32, "SetWindowPos", "int", [HWND_ARG, HWND_ARG, "int", "int", "int", "int", "uint"]);
		const SetForegroundWindow = bind(user32, "SetForegroundWindow", "int", [HWND_ARG]);
		const ShowWindow = bind(user32, "ShowWindow", "int", [HWND_ARG, "int"]);
		const LoadCursorW = bind(user32, "LoadCursorW", PVOID, [PVOID, "intptr_t"]);
		const SetCursor = bind(user32, "SetCursor", PVOID, [PVOID]);
		const MonitorFromPoint = bind(user32, "MonitorFromPoint", PVOID, ["int64", "uint32"]);
		const GetMonitorInfoW = bind(user32, "GetMonitorInfoW", "int", [PVOID, PVOID]);
		const GetDC = bind(user32, "GetDC", PVOID, [PVOID]);
		const ReleaseDC = bind(user32, "ReleaseDC", "int", [PVOID, PVOID]);
		const CreateCompatibleDC = bind(gdi32, "CreateCompatibleDC", PVOID, [PVOID]);
		const DeleteDC = bind(gdi32, "DeleteDC", "int", [PVOID]);
		const CreateCompatibleBitmap = bind(gdi32, "CreateCompatibleBitmap", PVOID, [PVOID, "int", "int"]);
		const DeleteObject = bind(gdi32, "DeleteObject", "int", [PVOID]);
		const SelectObject = bind(gdi32, "SelectObject", PVOID, [PVOID, PVOID]);
		const BitBlt = bind(gdi32, "BitBlt", "int", [PVOID, "int", "int", "int", "int", PVOID, "int", "int", "uint"]);
		const GetDIBits = bind(gdi32, "GetDIBits", "int", [PVOID, PVOID, "uint", "uint", PVOID, PVOID, "uint"]);

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
			setWindowPos(hwnd, insertAfter, x, y, cx, cy, flags) {
				return SetWindowPos(hwnd, insertAfter, x, y, cx, cy, flags) as number;
			},
			setForegroundWindow(hwnd) {
				return SetForegroundWindow(hwnd) as number;
			},
			showWindow(hwnd, cmd) {
				return ShowWindow(hwnd, cmd) as number;
			},
			setCrosshairCursor() {
				const IDC_CROSS = 32515;
				const hCross = LoadCursorW(null, IDC_CROSS);
				if (hCross) SetCursor(hCross);
			},
			setArrowCursor() {
				const IDC_ARROW = 32512;
				const hArrow = LoadCursorW(null, IDC_ARROW);
				if (hArrow) SetCursor(hArrow);
			},
			setThreadDpiAwareness,
			captureScreen(x, y, width, height) {
				if (width <= 0 || height <= 0) return null;
				const hdcScreen = GetDC(null);
				if (!hdcScreen) return null;
				const hdcMem = CreateCompatibleDC(hdcScreen);
				if (!hdcMem) {
					ReleaseDC(null, hdcScreen);
					return null;
				}
				const hbm = CreateCompatibleBitmap(hdcScreen, width, height);
				if (!hbm) {
					DeleteDC(hdcMem);
					ReleaseDC(null, hdcScreen);
					return null;
				}
				const oldBmp = SelectObject(hdcMem, hbm);
				const SRCCOPY = 0x00CC0020;
				const ok = BitBlt(hdcMem, 0, 0, width, height, hdcScreen, x, y, SRCCOPY);
				if (!ok) {
					SelectObject(hdcMem, oldBmp);
					DeleteObject(hbm);
					DeleteDC(hdcMem);
					ReleaseDC(null, hdcScreen);
					return null;
				}

				const biBuf = Buffer.alloc(40);
				biBuf.writeUInt32LE(40, 0);
				biBuf.writeInt32LE(width, 4);
				biBuf.writeInt32LE(-height, 8);
				biBuf.writeUInt16LE(1, 12);
				biBuf.writeUInt16LE(32, 14);

				const buf = Buffer.allocUnsafe(width * height * 4);
				const lines = GetDIBits(hdcMem, hbm, 0, height, buf, biBuf, 0);

				SelectObject(hdcMem, oldBmp);
				DeleteObject(hbm);
				DeleteDC(hdcMem);
				ReleaseDC(null, hdcScreen);

				if (typeof lines === "number" && lines <= 0) return null;

				const u32 = new Uint32Array(buf.buffer, buf.byteOffset, width * height);
				for (let i = 0; i < u32.length; i++) {
					const val = u32[i]!;
					// Fast 32-bit BGRX -> RGBA conversion
					u32[i] = ((val & 0xFF) << 16) | (val & 0x00FF00) | ((val >> 16) & 0xFF) | 0xFF000000;
				}

				return { pixels: new Uint8Array(buf), width, height };
			},
			getMonitorPhysicalRect(x, y) {
				const pt64 = (BigInt(y >>> 0) << 32n) | BigInt(x >>> 0);
				const MONITOR_DEFAULTTONEAREST = 2;
				const hMon = MonitorFromPoint(pt64, MONITOR_DEFAULTTONEAREST);
				if (!hMon) return null;
				const miBuf = Buffer.alloc(104);
				miBuf.writeUInt32LE(104, 0);
				if (!GetMonitorInfoW(hMon, miBuf)) return null;
				return {
					left: miBuf.readInt32LE(4),
					top: miBuf.readInt32LE(8),
					right: miBuf.readInt32LE(12),
					bottom: miBuf.readInt32LE(16),
				};
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
	// Point conversion uses the display that actually contains the pixel. A rect
	// conversion against `null` used to pick the primary display's scale, which
	// is how mixed-DPI and 125% laptops grew a 1px snap offset.
	return physicalRectToDip(phys, (point) => screen.screenToDipPoint(point));
}

export function detectWindowsOnWin32(excludeHwnd?: bigint): DetectedWindow[] {
	const api = loadApi();
	if (!api) return [];
	api.setThreadDpiAwareness();

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

			const title = api.getWindowText(hwnd) || cls || "";
			results.push({ id: asHwnd(hwnd).toString(), title, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
		} catch {
			// One bad HWND must not abort the rest of the z-order walk.
		}
		return true;
	});
	return results;
}

export const HWND_TOPMOST = -1n;
export const HWND_BOTTOM = 1n;
export const SWP_NOSIZE = 0x0001;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOZORDER = 0x0004;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_SHOWWINDOW = 0x0040;
export const SWP_HIDEWINDOW = 0x0080;

export function win32SetWindowPos(
	hwnd: bigint | number,
	insertAfter: bigint | number,
	x: number,
	y: number,
	cx: number,
	cy: number,
	flags: number,
): boolean {
	const api = loadApi();
	if (!api) return false;
	return api.setWindowPos(hwnd, insertAfter, x, y, cx, cy, flags) !== 0;
}

export function win32SetForegroundWindow(hwnd: bigint | number): boolean {
	const api = loadApi();
	if (!api) return false;
	return api.setForegroundWindow(hwnd) !== 0;
}

export function win32ShowWindow(hwnd: bigint | number, cmd: number): boolean {
	const api = loadApi();
	if (!api) return false;
	return api.showWindow(hwnd, cmd) !== 0;
}

export function win32SetCrosshairCursor(): void {
	const api = loadApi();
	if (!api) return;
	api.setCrosshairCursor();
}

export function win32RestoreArrowCursor(): void {
	const api = loadApi();
	if (!api) return;
	api.setArrowCursor();
}

export function win32CaptureScreen(
	x: number,
	y: number,
	width: number,
	height: number,
): { pixels: Uint8Array; width: number; height: number } | null {
	const api = loadApi();
	if (!api) return null;
	api.setThreadDpiAwareness();
	return api.captureScreen(x, y, width, height);
}

export function win32CoverDisplayPhysical(hwnd: unknown, display: Electron.Display): {
	left: number;
	top: number;
	width: number;
	height: number;
} | null {
	const api = loadApi();
	if (!api) return null;
	api.setThreadDpiAwareness();

	const scale = display.scaleFactor || 1;
	const testX = Math.round((display.bounds.x + 10) * scale);
	const testY = Math.round((display.bounds.y + 10) * scale);
	const phys = api.getMonitorPhysicalRect(testX, testY);

	const left = phys ? phys.left : Math.round(display.bounds.x * scale);
	const top = phys ? phys.top : Math.round(display.bounds.y * scale);
	const width = phys ? phys.right - phys.left : Math.round(display.bounds.width * scale);
	const height = phys ? phys.bottom - phys.top : Math.round(display.bounds.height * scale);

	const HWND_TOPMOST = 0xFFFFFFFFFFFFFFFFn;
	const SWP_FRAMECHANGED = 0x0020;
	const SWP_SHOWWINDOW = 0x0040;
	api.setWindowPos(asHwnd(hwnd), HWND_TOPMOST, left, top, width, height, SWP_FRAMECHANGED | SWP_SHOWWINDOW);

	return { left, top, width, height };
}

export function win32CaptureDisplay(display: Electron.Display): {
	pixels: Uint8Array;
	width: number;
	height: number;
	scaleFactor: number;
} | null {
	const api = loadApi();
	if (!api) return null;

	const scale = display.scaleFactor || 1;
	// Calculate a point inside the display in physical coordinates
	const testX = Math.round((display.bounds.x + 10) * scale);
	const testY = Math.round((display.bounds.y + 10) * scale);
	const phys = api.getMonitorPhysicalRect(testX, testY);

	const left = phys ? phys.left : Math.round(display.bounds.x * scale);
	const top = phys ? phys.top : Math.round(display.bounds.y * scale);
	const width = phys ? phys.right - phys.left : Math.round(display.bounds.width * scale);
	const height = phys ? phys.bottom - phys.top : Math.round(display.bounds.height * scale);

	const snapshot = api.captureScreen(left, top, width, height);
	if (!snapshot) return null;

	const accurateScale = display.bounds.width > 0 ? snapshot.width / display.bounds.width : scale;
	return {
		pixels: snapshot.pixels,
		width: snapshot.width,
		height: snapshot.height,
		scaleFactor: accurateScale,
	};
}
