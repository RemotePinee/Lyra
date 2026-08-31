/**
 * OS-level native drag ghost window for session tab tear-off.
 *
 * Appears instantly when a tab is dragged out of the window boundary and
 * tracks the mouse cursor across multiple monitors without DOM clipping.
 * Dynamically detects whether the cursor is hovering over an existing window's
 * tab bar area to switch visually between "Detach" and "Merge" modes (Chrome behavior).
 */

import { BrowserWindow, screen } from "electron";

let ghostWindow: BrowserWindow | null = null;
let currentMode: "detach" | "merge" = "detach";
let lastHoveredWindowId: number | null = null;

const GHOST_HTML = `<!DOCTYPE html>
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
    padding-left: 8px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .ghost-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    font-size: 11.5px;
    font-weight: 500;
    color: #ffffff;
    border-radius: 6px;
    white-space: nowrap;
    pointer-events: none;
    transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .ghost-pill.detach {
    background: #0284c7;
    border: 1px solid rgba(255, 255, 255, 0.25);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(2, 132, 199, 0.4);
  }
  .ghost-pill.merge {
    background: #10b981;
    border: 1px solid rgba(255, 255, 255, 0.35);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(16, 185, 129, 0.4);
  }
  .icon {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }
  .title {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    font-size: 10px;
    opacity: 0.9;
    font-weight: 400;
    padding-left: 2px;
  }
</style>
</head>
<body>
  <div class="ghost-pill detach" id="pill">
    <svg class="icon" id="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      <polyline points="15 3 21 3 21 9"></polyline>
      <line x1="10" y1="14" x2="21" y2="3"></line>
    </svg>
    <span class="title" id="title">新会话</span>
    <span class="hint" id="hint">释放以分离</span>
  </div>
  <script>
    const DETACH_ICON = '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>';
    const MERGE_ICON = '<path d="M12 5v14M5 12h14"></path>';

    window.addEventListener("message", (e) => {
      if (!e.data) return;
      if (typeof e.data.title === "string") {
        document.getElementById("title").textContent = e.data.title;
      }
      if (typeof e.data.mode === "string") {
        const pill = document.getElementById("pill");
        const hint = document.getElementById("hint");
        const icon = document.getElementById("icon");
        if (e.data.mode === "merge") {
          pill.className = "ghost-pill merge";
          hint.textContent = "释放以合并";
          icon.innerHTML = MERGE_ICON;
        } else {
          pill.className = "ghost-pill detach";
          hint.textContent = "释放以分离";
          icon.innerHTML = DETACH_ICON;
        }
      }
    });
  </script>
</body>
</html>`;

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
 * Check if the cursor is hovering over any other window (main window or secondary session window).
 * If hovering over any part of an existing window, we are in "Merge" mode!
 */
function checkTargetWindow(cursor: { x: number; y: number }, sourceWebContentsId?: number): {
	targetWin: BrowserWindow | null;
	isOverTabBar: boolean;
} {
	const allWindows = BrowserWindow.getAllWindows();
	for (const win of allWindows) {
		if (win.isDestroyed() || !win.isVisible()) continue;
		if (ghostWindow && win.id === ghostWindow.id) continue;
		if (sourceWebContentsId && win.webContents.id === sourceWebContentsId) continue;

		const b = win.getBounds();
		if (cursor.x >= b.x && cursor.x <= b.x + b.width && cursor.y >= b.y && cursor.y <= b.y + b.height) {
			// Tab bar is located in the top region (top 50px)
			const isOverTabBar = cursor.y <= b.y + 50;
			return { targetWin: win, isOverTabBar };
		}
	}
	return { targetWin: null, isOverTabBar: false };
}

export function showDragGhost(title: string, sourceWebContentsId?: number): void {
	const cursor = getPhysicalCursor();
	const width = 240;
	const height = 40;
	const rawX = Math.round(cursor.x - 24);
	const rawY = Math.round(cursor.y - 12);
	const { x, y } = clampToDisplay(rawX, rawY, width, height);

	const hit = checkTargetWindow(cursor, sourceWebContentsId);
	currentMode = hit.targetWin ? "merge" : "detach";

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
		void ghostWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(GHOST_HTML)}`);
		ghostWindow.webContents.once("did-finish-load", () => {
			if (!ghostWindow || ghostWindow.isDestroyed()) return;
			ghostWindow.webContents.postMessage("", { title, mode: currentMode });
			ghostWindow.showInactive();
		});
	} else {
		ghostWindow.setBounds({ x, y, width, height });
		ghostWindow.webContents.postMessage("", { title, mode: currentMode });
		if (!ghostWindow.isVisible()) {
			ghostWindow.showInactive();
		}
	}
}

export function moveDragGhost(title?: string, sourceWebContentsId?: number): void {
	const cursor = getPhysicalCursor();
	const width = 240;
	const height = 40;
	const rawX = Math.round(cursor.x - 24);
	const rawY = Math.round(cursor.y - 12);
	const { x, y } = clampToDisplay(rawX, rawY, width, height);

	const hit = checkTargetWindow(cursor, sourceWebContentsId);
	const nextMode: "detach" | "merge" = hit.targetWin ? "merge" : "detach";

	// Broadcast drag-over or drag-leave to target window if hovering state changes
	if (hit.targetWin) {
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
			ghostWindow.webContents.postMessage("", { mode: currentMode });
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
