import { BrowserWindow, desktopCapturer, screen } from "electron";

export interface SnippingResult {
	canceled: boolean;
	dataUrl?: string;
	error?: string;
}

let isSnipActive = false;

const HTML_CONTENT = `<!DOCTYPE html>
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
    cursor: crosshair;
  }
  #canvas {
    position: absolute;
    left: 0;
    top: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
  }
  #pill {
    position: absolute;
    display: none;
    background: rgba(20, 20, 22, 0.92);
    color: #f5f5f7;
    padding: 3px 7px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.3px;
    border-radius: 5px;
    pointer-events: none;
    border: 1px solid rgba(255, 255, 255, 0.22);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    z-index: 1000;
    white-space: nowrap;
    transform: translate(14px, 14px);
  }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="pill"></div>
<script>
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const pill = document.getElementById("pill");

  let dpr = window.devicePixelRatio || 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.scale(dpr, dpr);
  }
  resize();
  window.addEventListener("resize", resize);

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;

  function draw() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    if (!isDragging) {
      pill.style.display = "none";
      return;
    }

    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const w = Math.abs(currentX - startX);
    const h = Math.abs(currentY - startY);

    if (w > 0 && h > 0) {
      // 1. Crisp selection outline
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

      ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
      ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);

      // 2. Dimensions pill
      pill.style.display = "block";
      pill.textContent = Math.round(w) + " ✕ " + Math.round(h);

      let pillX = currentX;
      let pillY = currentY;
      if (pillX + 90 > window.innerWidth) {
        pillX = currentX - 90;
      }
      if (pillY + 45 > window.innerHeight) {
        pillY = currentY - 40;
      }
      pill.style.left = pillX + "px";
      pill.style.top = pillY + "px";
    }
  }

  window.addEventListener("mousedown", (e) => {
    if (e.button === 2) {
      console.log("SNIP_CANCEL");
      return;
    }
    if (e.button !== 0) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    currentX = e.clientX;
    currentY = e.clientY;
    draw();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    currentX = e.clientX;
    currentY = e.clientY;
    draw();
  });

  window.addEventListener("mouseup", (e) => {
    if (!isDragging) return;
    isDragging = false;
    currentX = e.clientX;
    currentY = e.clientY;

    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const w = Math.abs(currentX - startX);
    const h = Math.abs(currentY - startY);

    if (w < 4 || h < 4) {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      pill.style.display = "none";
      return;
    }

    console.log("SNIP_RECT:" + JSON.stringify({ x, y, w, h }));
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      console.log("SNIP_CANCEL");
    }
  });
</script>
</body>
</html>`;

const HTML_DATA_URL = `data:text/html;charset=utf-8,${encodeURIComponent(HTML_CONTENT)}`;

/**
 * Pure transparent snipping overlay.
 *
 * 1. Opens 100% transparent fullscreen window with native crosshair cursor.
 * 2. Pre-captures display buffer in parallel during selection drag.
 * 3. Draws selection rectangle only when user drags mouse.
 * 4. Crops and returns image on mouse-up.
 */
export async function openSnippingOverlay(): Promise<SnippingResult> {
	if (isSnipActive) {
		return { canceled: true };
	}
	isSnipActive = true;

	const primaryDisplay = screen.getPrimaryDisplay();
	const { width, height } = primaryDisplay.size;
	const scaleFactor = primaryDisplay.scaleFactor || 1;

	// Start screen capture concurrently in background
	const capturePromise = desktopCapturer.getSources({
		types: ["screen"],
		thumbnailSize: {
			width: Math.round(width * scaleFactor),
			height: Math.round(height * scaleFactor),
		},
	});

	return new Promise((resolve) => {
		let overlayWindow: BrowserWindow | null = new BrowserWindow({
			x: primaryDisplay.bounds.x,
			y: primaryDisplay.bounds.y,
			width: primaryDisplay.bounds.width,
			height: primaryDisplay.bounds.height,
			frame: false,
			show: false,
			transparent: true,
			hasShadow: false,
			alwaysOnTop: true,
			skipTaskbar: true,
			resizable: false,
			movable: false,
			enableLargerThanScreen: true,
			backgroundColor: "#00000000",
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: false,
			},
		});

		overlayWindow.setAlwaysOnTop(true);
		overlayWindow.setVisibleOnAllWorkspaces(true);

		const cleanup = () => {
			isSnipActive = false;
			if (overlayWindow && !overlayWindow.isDestroyed()) {
				overlayWindow.close();
			}
			overlayWindow = null;
		};

		overlayWindow.webContents.on("console-message", async (_event: Electron.Event, _level: number, message: string) => {
			if (message.startsWith("SNIP_RECT:")) {
				try {
					const rect = JSON.parse(message.slice("SNIP_RECT:".length)) as {
						x: number;
						y: number;
						w: number;
						h: number;
					};

					if (overlayWindow && !overlayWindow.isDestroyed()) {
						overlayWindow.hide();
					}

					const sources = await capturePromise;
					const primarySource = sources[0];
					if (!primarySource) {
						cleanup();
						resolve({ canceled: false, error: "未能捕获到屏幕" });
						return;
					}

					// NativeImage.crop in physical pixel space
					const cropRect = {
						x: Math.max(0, Math.round(rect.x * scaleFactor)),
						y: Math.max(0, Math.round(rect.y * scaleFactor)),
						width: Math.min(Math.round(rect.w * scaleFactor), Math.round(width * scaleFactor)),
						height: Math.min(Math.round(rect.h * scaleFactor), Math.round(height * scaleFactor)),
					};

					if (cropRect.width <= 0 || cropRect.height <= 0) {
						cleanup();
						resolve({ canceled: true });
						return;
					}

					const cropped = primarySource.thumbnail.crop(cropRect);
					const dataUrl = cropped.toDataURL();
					cleanup();
					resolve({ canceled: false, dataUrl });
				} catch (err) {
					cleanup();
					resolve({ canceled: false, error: err instanceof Error ? err.message : String(err) });
				}
			} else if (message === "SNIP_CANCEL") {
				cleanup();
				resolve({ canceled: true });
			}
		});

		overlayWindow.on("closed", () => {
			cleanup();
			resolve({ canceled: true });
		});

		overlayWindow.once("ready-to-show", () => {
			overlayWindow?.show();
			overlayWindow?.focus();
		});

		overlayWindow.loadURL(HTML_DATA_URL);
	});
}