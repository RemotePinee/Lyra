interface ScreenshotWindowState {
	isDestroyed(): boolean;
}

const screenshotWindows = new WeakSet<object>();

/** Mark capture windows so global application styling never paints their transparent backing store. */
export function markScreenshotWindow<T extends object>(window: T): T {
	screenshotWindows.add(window);
	return window;
}

export function isScreenshotWindow(window: object): boolean {
	return screenshotWindows.has(window);
}

export function shouldApplyWindowTheme(window: ScreenshotWindowState): boolean {
	return !window.isDestroyed() && !isScreenshotWindow(window);
}

interface ThemeableWindow extends ScreenshotWindowState {
	setBackgroundColor(color: string): void;
	setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void;
}

/** Apply application chrome colors without ever touching a transparent capture window. */
export function applyThemeToWindows(
	windows: readonly ThemeableWindow[],
	colors: { color: string; symbolColor: string },
	withTitleBarOverlay: boolean,
): void {
	for (const window of windows) {
		if (!shouldApplyWindowTheme(window)) continue;
		window.setBackgroundColor(colors.color);
		if (!withTitleBarOverlay) continue;
		try {
			window.setTitleBarOverlay({ ...colors, height: 38 });
		} catch {
			// Some native window configurations do not have a title bar overlay.
		}
	}
}

/** Select the application window without ever returning an active or prewarmed capture window. */
export function findScreenshotReturnWindow<T extends ScreenshotWindowState>(
	windows: readonly T[],
	activeOverlays: readonly T[],
	prewarmedOverlay: T | null,
): T | undefined {
	const excluded = new Set(activeOverlays);
	return windows.find(
		(win) => !excluded.has(win) && win !== prewarmedOverlay && !win.isDestroyed(),
	);
}

/**
 * Pin a capture overlay's *content* to a display, not its outer frame.
 *
 * On Windows a frameless window still has `WS_THICKFRAME` unless told otherwise,
 * so `setBounds(display.bounds)` sizes the chrome and the CSS origin sits a few
 * pixels inside the screen. Snap rects are in display DIP; pointer events are
 * in content DIP — that mismatch is the 1–7px hover/selection jump.
 */
export function coverDisplay(
	win: {
		setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
		setContentBounds(bounds: { x: number; y: number; width: number; height: number }): void;
	},
	bounds: { x: number; y: number; width: number; height: number },
): void {
	win.setBounds(bounds);
	try {
		win.setContentBounds(bounds);
	} catch {
		// Some native window types reject a content-bounds write; the outer bounds still applied.
	}
}

/** Preserve renderer readiness even when a prewarmed page reports it before a session exists. */
export class ScreenshotRendererGate {
	private readonly ready = new Set<number>();
	private readonly waiting = new Map<number, () => void>();

	markReady(id: number): void {
		this.ready.add(id);
		const reveal = this.waiting.get(id);
		if (!reveal) return;
		this.waiting.delete(id);
		reveal();
	}

	whenReady(id: number, reveal: () => void): void {
		if (this.ready.has(id)) {
			reveal();
			return;
		}
		this.waiting.set(id, reveal);
	}

	markLoading(id: number): void {
		this.ready.delete(id);
	}

	forget(id: number): void {
		this.ready.delete(id);
		this.waiting.delete(id);
	}
}
