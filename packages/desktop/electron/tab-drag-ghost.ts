/**
 * OS-level native drag ghost window for session tab tear-off.
 *
 * Appears instantly when a tab is dragged out of the window boundary and
 * tracks the mouse cursor across multiple monitors without DOM clipping.
 */

import { BrowserWindow, screen } from "electron";

let ghostWindow: BrowserWindow | null = null;

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
    background: #0284c7;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(2, 132, 199, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.25);
    white-space: nowrap;
    pointer-events: none;
  }
  .icon {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }
  .title {
    max-width: 150px;
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
  <div class="ghost-pill">
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      <polyline points="15 3 21 3 21 9"></polyline>
      <line x1="10" y1="14" x2="21" y2="3"></line>
    </svg>
    <span class="title" id="title">新会话</span>
    <span class="hint">释放以分离</span>
  </div>
  <script>
    window.addEventListener("message", (e) => {
      if (e.data && typeof e.data.title === "string") {
        document.getElementById("title").textContent = e.data.title;
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

export function showDragGhost(title: string): void {
	const cursor = getPhysicalCursor();
	const width = 240;
	const height = 40;
	// Anchor: cursor sits smoothly near top-left of the drag capsule (x-24, y-12)
	const rawX = Math.round(cursor.x - 24);
	const rawY = Math.round(cursor.y - 12);
	const { x, y } = clampToDisplay(rawX, rawY, width, height);

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
			ghostWindow.webContents.postMessage("", { title });
			ghostWindow.showInactive();
		});
	} else {
		ghostWindow.setBounds({ x, y, width, height });
		if (!ghostWindow.isVisible()) {
			ghostWindow.webContents.postMessage("", { title });
			ghostWindow.showInactive();
		}
	}
}

export function moveDragGhost(title?: string): void {
	const cursor = getPhysicalCursor();
	const width = 240;
	const height = 40;
	const rawX = Math.round(cursor.x - 24);
	const rawY = Math.round(cursor.y - 12);
	const { x, y } = clampToDisplay(rawX, rawY, width, height);

	if (!ghostWindow || ghostWindow.isDestroyed() || !ghostWindow.isVisible()) {
		showDragGhost(title ?? "新会话");
	} else {
		ghostWindow.setBounds({ x, y, width, height });
	}
}

export function hideDragGhost(): void {
	if (ghostWindow && !ghostWindow.isDestroyed()) {
		ghostWindow.hide();
	}
}

export function destroyDragGhost(): void {
	if (ghostWindow && !ghostWindow.isDestroyed()) {
		ghostWindow.destroy();
		ghostWindow = null;
	}
}
