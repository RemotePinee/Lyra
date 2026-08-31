/**
 * OS-level native drag ghost window for session tab tear-off.
 *
 * Appears instantly when a tab is dragged out of the window boundary and
 * tracks the mouse cursor across multiple monitors without DOM clipping.
 * Dynamically detects whether the cursor is hovering over an existing window's
 * tab bar area to switch visually between "Detach" and "Merge" modes (Chrome behavior).
 */

import { BrowserWindow, screen } from "electron";
import { bootTheme } from "./window.ts";

let ghostWindow: BrowserWindow | null = null;
let currentMode: "detach" | "merge" | "back" = "detach";
let lastHoveredWindowId: number | null = null;

function buildGhostHtml(): string {
	const theme = bootTheme();
	const accentColor = theme.accent || "#339cff";
	const okColor = "#3ecf8e";
	const elevatedBg = theme.dark ? "#2c2c2c" : "#e5e5e5";
	const textColor = theme.dark ? "#ededed" : "#1a1a1a";
	const lineRule = theme.dark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.12)";

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  html, body {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: 0 4px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .ghost-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 9px;
    font-size: 11.5px;
    font-weight: 500;
    color: #ffffff;
    border-radius: 6px;
    white-space: nowrap;
    pointer-events: none;
    transition: background 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .ghost-pill.detach {
    background: ${accentColor};
    border: 1px solid rgba(255, 255, 255, 0.35);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35), 0 1px 4px rgba(0, 0, 0, 0.4);
  }
  .ghost-pill.merge {
    background: ${okColor};
    color: #0f172a;
    border: 1px solid rgba(255, 255, 255, 0.45);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35), 0 1px 4px rgba(0, 0, 0, 0.5);
  }
  .ghost-pill.back {
    background: ${elevatedBg};
    color: ${textColor};
    border: 1px solid ${lineRule};
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
  }
  .icon {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }
  .title {
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.22);
  }
  .ghost-pill.merge .badge {
    background: rgba(0, 0, 0, 0.15);
  }
  .ghost-pill.back .badge {
    background: rgba(128, 128, 128, 0.2);
  }
</style>
</head>
<body>
  <div class="ghost-pill detach" id="pill">
    <svg class="icon" id="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      <polyline points="15 3 21 3 21 9"></polyline>
      <line x1="10" y1="14" x2="21" y2="3"></line>
    </svg>
    <span class="title" id="title">新会话</span>
    <span class="badge" id="badge">独立分屏</span>
  </div>
  <script>
    const DETACH_ICON = '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>';
    const MERGE_ICON = '<path d="M12 5v14M5 12h14"></path>';
    const BACK_ICON = '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>';

    window.updateGhost = function(title, mode) {
      const pill = document.getElementById("pill");
      const titleEl = document.getElementById("title");
      const badge = document.getElementById("badge");
      const icon = document.getElementById("icon");
      if (title && titleEl) titleEl.textContent = title;
      if (mode === "merge") {
        pill.className = "ghost-pill merge";
        badge.textContent = "合并窗口";
        icon.innerHTML = MERGE_ICON;
      } else if (mode === "back") {
        pill.className = "ghost-pill back";
        badge.textContent = "放回原处";
        icon.innerHTML = BACK_ICON;
      } else if (mode === "detach") {
        pill.className = "ghost-pill detach";
        badge.textContent = "独立分屏";
        icon.innerHTML = DETACH_ICON;
      }
    };
  </script>
</body>
</html>`;
}

function getPhysicalCursor(): { x: number; y: number } {
	return screen.getCursorScreenPoint();
}

/**
 * Align coordinates with display work area bounds to ensure crisp positioning
 * across mixed-DPI multi-monitor environments.
 */
function clampToDisplay(x: number, y: number, width: number, height: number): { x: number; y: number } {
	const currentDisplay = screen.getDisplayNearestPoint({ x, y });
	const { workArea } = currentDisplay;
	return {
		x: Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, x)),
		y: Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, y)),
	};
}

/**
 * Check if the cursor is hovering over any other window (main window or secondary session window),
 * or returning to the source window itself.
 */
function checkTargetWindow(cursor: { x: number; y: number }, sourceWebContentsId?: number): {
	targetWin: BrowserWindow | null;
	isSourceWin: boolean;
	isOverTabBar: boolean;
} {
	const allWindows = BrowserWindow.getAllWindows();
	let isSourceWin = false;

	for (const win of allWindows) {
		if (win.isDestroyed() || !win.isVisible()) continue;
		if (ghostWindow && win.id === ghostWindow.id) continue;

		const b = win.getBounds();
		if (cursor.x >= b.x && cursor.x <= b.x + b.width && cursor.y >= b.y && cursor.y <= b.y + b.height) {
			const isOverTabBar = cursor.y <= b.y + 50;
			if (sourceWebContentsId && win.webContents.id === sourceWebContentsId) {
				isSourceWin = true;
				return { targetWin: win, isSourceWin: true, isOverTabBar };
			}
			return { targetWin: win, isSourceWin: false, isOverTabBar };
		}
	}
	return { targetWin: null, isSourceWin, isOverTabBar: false };
}

export function showDragGhost(title: string, sourceWebContentsId?: number): void {
	const cursor = getPhysicalCursor();
	const width = 210;
	const height = 36;
	const rawX = Math.round(cursor.x - 20);
	const rawY = Math.round(cursor.y - 12);
	const { x, y } = clampToDisplay(rawX, rawY, width, height);

	const hit = checkTargetWindow(cursor, sourceWebContentsId);
	currentMode = hit.isSourceWin ? "back" : (hit.targetWin ? "merge" : "detach");

	if (!ghostWindow || ghostWindow.isDestroyed()) {
		ghostWindow = new BrowserWindow({
			width,
			height,
			x,
			y,
			frame: false,
			transparent: true,
			alwaysOnTop: true,
			skipTaskbar: true,
			resizable: false,
			hasShadow: false,
			focusable: false,
			show: false,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
			},
		});

		ghostWindow.setIgnoreMouseEvents(true);
		void ghostWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildGhostHtml())}`);
		ghostWindow.webContents.once("did-finish-load", () => {
			if (!ghostWindow || ghostWindow.isDestroyed()) return;
			void ghostWindow.webContents.executeJavaScript(
				`window.updateGhost(${JSON.stringify(title)}, ${JSON.stringify(currentMode)})`,
			);
			ghostWindow.showInactive();
		});
	} else {
		ghostWindow.setBounds({ x, y, width, height });
		void ghostWindow.webContents.executeJavaScript(
			`window.updateGhost(${JSON.stringify(title)}, ${JSON.stringify(currentMode)})`,
		);
		if (!ghostWindow.isVisible()) {
			ghostWindow.showInactive();
		}
	}
}

export function moveDragGhost(title?: string, sourceWebContentsId?: number): void {
	const cursor = getPhysicalCursor();
	const width = 210;
	const height = 36;
	const rawX = Math.round(cursor.x - 20);
	const rawY = Math.round(cursor.y - 12);
	const { x, y } = clampToDisplay(rawX, rawY, width, height);

	const hit = checkTargetWindow(cursor, sourceWebContentsId);
	const nextMode: "detach" | "merge" | "back" = hit.isSourceWin ? "back" : (hit.targetWin ? "merge" : "detach");

	// Broadcast drag-over or drag-leave to target window if hovering state changes
	if (hit.targetWin && !hit.isSourceWin) {
		const winBounds = hit.targetWin.getBounds();
		const relativeX = cursor.x - winBounds.x;
		hit.targetWin.webContents.send("sessions:tabDragOver", { x: relativeX, title });
		lastHoveredWindowId = hit.targetWin.id;
	} else if (lastHoveredWindowId !== null) {
		const lastWin = BrowserWindow.fromId(lastHoveredWindowId);
		if (lastWin && !lastWin.isDestroyed()) {
			lastWin.webContents.send("sessions:tabDragLeave");
		}
		lastHoveredWindowId = null;
	}

	if (!ghostWindow || ghostWindow.isDestroyed() || !ghostWindow.isVisible()) {
		showDragGhost(title ?? "新会话", sourceWebContentsId);
	} else {
		ghostWindow.setBounds({ x, y, width, height });
		if (nextMode !== currentMode) {
			currentMode = nextMode;
			void ghostWindow.webContents.executeJavaScript(
				`window.updateGhost(${JSON.stringify(title ?? "")}, ${JSON.stringify(currentMode)})`,
			);
		}
	}
}

export function hideDragGhost(): void {
	if (lastHoveredWindowId !== null) {
		const lastWin = BrowserWindow.fromId(lastHoveredWindowId);
		if (lastWin && !lastWin.isDestroyed()) {
			lastWin.webContents.send("sessions:tabDragLeave");
		}
		lastHoveredWindowId = null;
	}
	if (ghostWindow && !ghostWindow.isDestroyed()) {
		ghostWindow.hide();
	}
}

export function destroyDragGhost(): void {
	if (lastHoveredWindowId !== null) {
		const lastWin = BrowserWindow.fromId(lastHoveredWindowId);
		if (lastWin && !lastWin.isDestroyed()) {
			lastWin.webContents.send("sessions:tabDragLeave");
		}
		lastHoveredWindowId = null;
	}
	if (ghostWindow && !ghostWindow.isDestroyed()) {
		ghostWindow.destroy();
		ghostWindow = null;
	}
}
