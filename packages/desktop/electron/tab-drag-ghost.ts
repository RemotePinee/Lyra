/**
 * OS-level native drag ghost window for session tab tear-off.
 *
 * Appears instantly when a tab is dragged out of the window boundary and
 * tracks the mouse cursor across multiple monitors without DOM clipping.
 */

import { BrowserWindow } from "electron";

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
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .ghost-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    font-size: 12px;
    font-weight: 500;
    color: #ffffff;
    background: #0284c7;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(2, 132, 199, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.25);
    white-space: nowrap;
    pointer-events: none;
  }
  .icon {
    width: 13px;
    height: 13px;
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

export function showDragGhost(title: string, screenX: number, screenY: number): void {
	const posX = Math.round(screenX - 70);
	const posY = Math.round(screenY - 18);

	if (!ghostWindow || ghostWindow.isDestroyed()) {
		ghostWindow = new BrowserWindow({
			width: 260,
			height: 48,
			x: posX,
			y: posY,
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
		ghostWindow.setBounds({ x: posX, y: posY, width: 260, height: 48 });
		if (!ghostWindow.isVisible()) {
			ghostWindow.webContents.postMessage("", { title });
			ghostWindow.showInactive();
		}
	}
}

export function moveDragGhost(screenX: number, screenY: number): void {
	if (ghostWindow && !ghostWindow.isDestroyed() && ghostWindow.isVisible()) {
		ghostWindow.setBounds({
			x: Math.round(screenX - 70),
			y: Math.round(screenY - 18),
			width: 260,
			height: 48,
		});
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
