/**
 * Visible on-screen windows, in Z-order, for the screenshot overlay's hover-snap.
 *
 * The overlay itself is DIP coordinates. Callers convert pointer events through `findSnapWindow`.
 * Platform backends are responsible for returning DIP rects, not physical pixels.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DetectedWindow {
	id: number | string;
	title: string;
	owner?: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface DetectWindowsOptions {
	/** Native HWND of the overlay, so it does not snap to itself. */
	excludeHwnd?: bigint;
	/** Overlay's display bounds; used on macOS/Linux where we do not have an HWND. */
	excludeBounds?: { x: number; y: number; width: number; height: number };
}

const SKIP_CLASSES = new Set([
	"Progman",
	"WorkerW",
	"Shell_TrayWnd",
	"Shell_SecondaryTrayWnd",
	"NotifyIconOverflowWindow",
	"Windows.UI.Core.CoreWindow",
	"IME",
	"MSCTFIME UI",
]);

export function isIgnoredWindowClass(cls: string): boolean {
	return SKIP_CLASSES.has(cls);
}

export function hwndFromNativeHandle(buf: Buffer): bigint {
	if (buf.length >= 8) return buf.readBigUInt64LE(0);
	if (buf.length >= 4) return BigInt(buf.readUInt32LE(0));
	return 0n;
}

/** Decode a fixed-size Win32 UTF-16LE buffer up to its first aligned NUL code unit. */
export function readNullTerminatedUtf16(buf: Buffer): string {
	let end = 0;
	while (end + 1 < buf.length && (buf[end] !== 0 || buf[end + 1] !== 0)) end += 2;
	return buf.toString("utf16le", 0, end).trim();
}

export function sameBounds(
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number },
	slack = 4,
): boolean {
	return (
		Math.abs(a.x - b.x) <= slack &&
		Math.abs(a.y - b.y) <= slack &&
		Math.abs(a.width - b.width) <= slack &&
		Math.abs(a.height - b.height) <= slack
	);
}

/**
 * Convert a physical-pixel rect to DIP by rounding each edge, then subtracting.
 *
 * Rounding `x/y/width/height` independently is how a 1px snap offset is born at
 * 125%/150% scale: the right edge of the window and `x + width` stop agreeing.
 * Callers supply the point converter so this stays testable without Electron.
 */
export function physicalRectToDip(
	phys: { left: number; top: number; right: number; bottom: number },
	toDipPoint: (point: { x: number; y: number }) => { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
	const topLeft = toDipPoint({ x: phys.left, y: phys.top });
	const bottomRight = toDipPoint({ x: phys.right, y: phys.bottom });
	const left = Math.round(topLeft.x);
	const top = Math.round(topLeft.y);
	const right = Math.round(bottomRight.x);
	const bottom = Math.round(bottomRight.y);
	return { x: left, y: top, width: right - left, height: bottom - top };
}

function parseTabLine(line: string, fields: number): string[] | null {
	const parts = line.split("\t");
	return parts.length >= fields ? parts : null;
}

/**
 * macOS: CGWindowList, on-screen only, layer 0. PID is used to drop our own overlay.
 */
async function detectWindowsOnDarwin(
	excludeBounds?: DetectWindowsOptions["excludeBounds"],
): Promise<DetectedWindow[]> {
	const script = `
use framework "Foundation"
use framework "CoreGraphics"

set windowList to current application's CGWindowListCopyWindowInfo((current application's kCGWindowListOptionOnScreenOnly as integer), (current application's kCGNullWindowID as integer))
set outText to ""

repeat with winInfo in (windowList as list)
    set layer to (winInfo's objectForKey:"kCGWindowLayer") as integer
    set alpha to (winInfo's objectForKey:"kCGWindowAlpha") as real
    set bounds to winInfo's objectForKey:"kCGWindowBounds"
    set owner to (winInfo's objectForKey:"kCGWindowOwnerName") as text
    set name to (winInfo's objectForKey:"kCGWindowName") as text
    set pid to (winInfo's objectForKey:"kCGWindowOwnerPID") as integer

    if layer is 0 and alpha > 0.05 then
        set x to (bounds's objectForKey:"X") as integer
        set y to (bounds's objectForKey:"Y") as integer
        set w to (bounds's objectForKey:"Width") as integer
        set h to (bounds's objectForKey:"Height") as integer
        set winId to (winInfo's objectForKey:"kCGWindowNumber") as integer
        if w > 50 and h > 50 then
            set title to owner
            if name is not "" and name is not "missing value" then
                set title to owner & " - " & name
            end if
            set outText to outText & winId & tab & x & tab & y & tab & w & tab & h & tab & pid & tab & title & linefeed
        end if
    end if
end repeat

return outText
`;

	try {
		const { stdout } = await execFileAsync("osascript", ["-e", script], {
			timeout: 800,
			encoding: "utf8",
		});
		const results: DetectedWindow[] = [];
		for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
			const parts = parseTabLine(line, 6);
			if (!parts) continue;
			const x = Number.parseInt(parts[1]!, 10);
			const y = Number.parseInt(parts[2]!, 10);
			const width = Number.parseInt(parts[3]!, 10);
			const height = Number.parseInt(parts[4]!, 10);
			const pid = Number.parseInt(parts[5]!, 10);
			const title = parts.slice(6).join("\t") || "";
			if (Number.isNaN(x) || Number.isNaN(y) || width <= 0 || height <= 0) continue;
			const rect = { x, y, width, height };
			if (pid === process.pid && excludeBounds && sameBounds(rect, excludeBounds)) continue;
			results.push({ id: parts[0]!, title, x, y, width, height });
		}
		return results;
	} catch {
		return [];
	}
}

async function detectWindowsOnLinux(
	excludeBounds?: DetectWindowsOptions["excludeBounds"],
): Promise<DetectedWindow[]> {
	try {
		const { stdout } = await execFileAsync("wmctrl", ["-lG"], { timeout: 800, encoding: "utf8" });
		const results: DetectedWindow[] = [];
		for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 8) continue;
			const x = Number.parseInt(parts[2]!, 10);
			const y = Number.parseInt(parts[3]!, 10);
			const width = Number.parseInt(parts[4]!, 10);
			const height = Number.parseInt(parts[5]!, 10);
			const title = parts.slice(7).join(" ");
			if (Number.isNaN(x) || Number.isNaN(y) || width <= 50 || height <= 50) continue;
			const rect = { x, y, width, height };
			if (excludeBounds && sameBounds(rect, excludeBounds)) continue;
			results.push({ id: parts[0]!, title, x, y, width, height });
		}
		return results;
	} catch {
		return [];
	}
}

export async function detectVisibleWindows(options?: DetectWindowsOptions): Promise<DetectedWindow[]> {
	if (process.platform === "win32") {
		const { detectWindowsOnWin32 } = await import("./window-detect-win32.ts");
		return detectWindowsOnWin32(options?.excludeHwnd);
	}
	if (process.platform === "darwin") {
		return detectWindowsOnDarwin(options?.excludeBounds);
	}
	if (process.platform === "linux") {
		return detectWindowsOnLinux(options?.excludeBounds);
	}
	return [];
}
