/**
 * The status bar item: reaching the app without going through its window.
 *
 * What it is for is starting something. An agent runs for minutes at a time, so the window spends
 * most of its life closed or behind something else, and "I want to ask it one thing" should not
 * begin with finding a window. The menu is therefore the four things worth doing from cold —
 * a new conversation, the two lists that accumulate work while you are away, and settings.
 *
 * Icon handling differs by platform in a way that is not cosmetic:
 *
 *   - macOS gets a template image, which the system fills with the menu bar's own foreground
 *     colour. That is the only correct answer there, because the menu bar inverts under a dark
 *     wallpaper, under a pulled-down menu and under an active-app highlight — a fixed bitmap is
 *     wrong in at least one of those, whichever one it is drawn for.
 *   - Windows and Linux have no equivalent, so the same silhouette is shipped pre-filled in both
 *     directions and swapped when the system theme changes.
 *
 * Both are generated from one drawing by `scripts/make-tray-icons.mjs`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, Menu, nativeImage, nativeTheme, Tray } from "electron";

/** What a menu item asks the renderer to do. Kept as strings, matched in `src/tray.ts`. */
export type TrayCommand = "new-session" | "pull-requests" | "scheduled" | "settings";

export interface TrayActions {
	/** Bring the window up, creating it if it is gone, and run `then` once it can receive events. */
	reveal: (then?: () => void) => void;
	/** The live window, or null when there is none. */
	window: () => Electron.BrowserWindow | null;
	send: (command: TrayCommand) => void;
}

let tray: Tray | null = null;
let actions: TrayActions | null = null;
let unwatchTheme: (() => void) | null = null;

/**
 * Where the icons are, packaged or not — the same two-place search the app icon does.
 *
 * Returns undefined rather than a wrong path: Electron falls back to an empty image on a missing
 * file without complaining, and an invisible status bar item is a much worse thing to debug than
 * a missing one.
 */
function iconPath(name: string): string | undefined {
	const base = app.getAppPath();
	return [
		join(base, "build", "tray", name),
		join(base, "..", "build", "tray", name),
		join(process.resourcesPath ?? "", "build", "tray", name),
	].find((path) => existsSync(path));
}

function currentIcon(): Electron.NativeImage {
	if (process.platform === "darwin") {
		const path = iconPath("trayTemplate.png");
		const image = path ? nativeImage.createFromPath(path) : nativeImage.createEmpty();
		// Belt and braces: the `Template` suffix already means this, but only when the file is
		// loaded from disk under that name — and being wrong here costs a black square on a black
		// menu bar.
		image.setTemplateImage(true);
		return image;
	}

	// Dark tray, light icon. `shouldUseDarkColors` follows the system rather than our own theme
	// setting on purpose: the icon sits in the system's furniture, not in ours.
	const path = iconPath(nativeTheme.shouldUseDarkColors ? "tray-light.png" : "tray-dark.png");
	return path ? nativeImage.createFromPath(path) : nativeImage.createEmpty();
}

function buildMenu(): Electron.Menu {
	const visible = actions?.window()?.isVisible() ?? false;

	return Menu.buildFromTemplate([
		{
			label: visible ? "隐藏 Lyra" : "打开 Lyra",
			click: () => {
				const window = actions?.window();
				if (visible && window) window.hide();
				else actions?.reveal();
			},
		},
		{ type: "separator" },
		{ label: "新对话", click: () => actions?.send("new-session") },
		{ label: "拉取请求", click: () => actions?.send("pull-requests") },
		{ label: "已安排", click: () => actions?.send("scheduled") },
		{ type: "separator" },
		{ label: "设置…", click: () => actions?.send("settings") },
		{ type: "separator" },
		{
			label: "退出 Lyra",
			/*
			 * The one way out on Windows and Linux, where closing the window only hides it.
			 * `app.quit()` rather than `exit`, so `before-quit` still gets to shut down the
			 * sessions, the shells and the sync server.
			 */
			click: () => app.quit(),
		},
	]);
}

/** Rebuilt on open, because the first item names what will happen rather than what exists. */
function refreshMenu(): void {
	if (!tray) return;
	if (process.platform === "darwin") tray.setContextMenu(buildMenu());
}

export function createTray(next: TrayActions): void {
	if (tray) return;
	actions = next;

	/*
	 * An empty image would still make a status bar item, just an invisible one — indistinguishable
	 * from the tray having failed outright, and impossible to click your way back from. Say so
	 * instead: the icons are generated and committed, so a miss here means either the generator
	 * has not been run or the packaging did not carry `build/tray`.
	 */
	const image = currentIcon();
	if (image.isEmpty()) {
		console.warn(`[lyra] 状态栏图标找不到（appPath=${app.getAppPath()}），跳过。跑 pnpm tray:icons 生成。`);
		return;
	}

	tray = new Tray(image);
	tray.setToolTip("Lyra");

	/*
	 * Left click toggles, right click opens the menu.
	 *
	 * On macOS setting a context menu takes the click event entirely — the item stops toggling and
	 * only ever opens a menu — so the menu is attached to the right button alone and the toggle
	 * keeps the left. Windows raises `click` and `right-click` separately and needs no such care.
	 */
	tray.on("click", () => {
		const window = actions?.window();
		if (window?.isVisible() && !window.isMinimized()) window.hide();
		else actions?.reveal();
		refreshMenu();
	});

	tray.on("right-click", () => {
		refreshMenu();
		tray?.popUpContextMenu(buildMenu());
	});

	// Windows and Linux only: the macOS icon is a template and inverts by itself.
	if (process.platform !== "darwin") {
		const onThemeChange = () => tray?.setImage(currentIcon());
		nativeTheme.on("updated", onThemeChange);
		unwatchTheme = () => nativeTheme.removeListener("updated", onThemeChange);
	}
}

export function destroyTray(): void {
	unwatchTheme?.();
	unwatchTheme = null;
	tray?.destroy();
	tray = null;
	actions = null;
}

/** Whether a status bar item exists, which is what decides if closing a window may hide it. */
export function hasTray(): boolean {
	return tray !== null;
}
