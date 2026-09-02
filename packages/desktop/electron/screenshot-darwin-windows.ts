/**
 * Where macOS on-screen windows sit.
 *
 * CoreGraphics window listing via osascript bridge for macOS platform driver.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowRect {
	x: number;
	y: number;
	width: number;
	height: number;
	app: string;
}

const SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("Foundation");
const ref = $.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
  $.kCGNullWindowID,
);
const all = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
JSON.stringify(
  all
    .filter((w) => w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 60 && w.kCGWindowBounds.Height > 60)
    .map((w) => ({
      x: w.kCGWindowBounds.X,
      y: w.kCGWindowBounds.Y,
      width: w.kCGWindowBounds.Width,
      height: w.kCGWindowBounds.Height,
      app: String(w.kCGWindowOwnerName || ""),
    })),
);
`;

export async function listDarwinWindows(display: { x: number; y: number; width: number; height: number }): Promise<WindowRect[]> {
	if (process.platform !== "darwin") return [];
	try {
		const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", SCRIPT], {
			timeout: 2000,
			maxBuffer: 4 * 1024 * 1024,
		});
		const raw = JSON.parse(stdout.trim() || "[]") as WindowRect[];
		return raw
			.map((w) => ({ ...w, x: w.x - display.x, y: w.y - display.y }))
			.filter((w) => w.x < display.width && w.y < display.height && w.x + w.width > 0 && w.y + w.height > 0);
	} catch (err) {
		console.error("[screenshot] macOS 读取窗口列表失败:", err);
		return [];
	}
}
