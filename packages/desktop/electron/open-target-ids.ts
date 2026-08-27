/**
 * Which targets exist, what they are called, and what an old setting means.
 *
 * Split from `open-targets.ts` so it can be read — and tested — without Electron: everything here
 * is a table or a lookup, and the half that shells out to the operating system is next door.
 */

type Kind = "reveal" | "app" | "terminal";

export interface Candidate {
	id: string;
	label: string;
	kind: Kind;
	/** macOS: the bundle's display name, which is how `open -a` finds it. */
	appName?: string;
	/** Windows: absolute paths to try, relative to the environment variables below. */
	windows?: { dir: "localAppData" | "programFiles" | "programFilesX86" | "windir"; path: string }[];
	/** Windows and Linux: the command to look for on PATH when no fixed path matched. */
	command?: string;
}

/**
 * The applications worth offering, per platform.
 *
 * A shortlist rather than everything installed: this answers 「点击文件路径时用哪个应用打开」, and a
 * list of every application on the machine is a file dialog, not a setting. Anything missing is
 * still reachable — an unrecognised id falls through to the system's own default handler.
 */
export const CANDIDATES: Record<string, Candidate[]> = {
	darwin: [
		{ id: "vscode", label: "Visual Studio Code", kind: "app", appName: "Visual Studio Code" },
		{ id: "cursor", label: "Cursor", kind: "app", appName: "Cursor" },
		{ id: "zed", label: "Zed", kind: "app", appName: "Zed" },
		{ id: "sublime", label: "Sublime Text", kind: "app", appName: "Sublime Text" },
		{ id: "xcode", label: "Xcode", kind: "app", appName: "Xcode" },
		{ id: "terminal", label: "终端", kind: "terminal", appName: "Terminal" },
		{ id: "iterm", label: "iTerm", kind: "terminal", appName: "iTerm" },
		{ id: "ghostty", label: "Ghostty", kind: "terminal", appName: "Ghostty" },
	],
	win32: [
		{
			id: "vscode",
			label: "Visual Studio Code",
			kind: "app",
			windows: [
				{ dir: "localAppData", path: "Programs\\Microsoft VS Code\\Code.exe" },
				{ dir: "programFiles", path: "Microsoft VS Code\\Code.exe" },
				{ dir: "programFilesX86", path: "Microsoft VS Code\\Code.exe" },
			],
			command: "code.cmd",
		},
		{
			id: "cursor",
			label: "Cursor",
			kind: "app",
			windows: [
				{ dir: "localAppData", path: "Programs\\cursor\\Cursor.exe" },
				{ dir: "programFiles", path: "cursor\\Cursor.exe" },
			],
			command: "cursor.cmd",
		},
		{
			id: "zed",
			label: "Zed",
			kind: "app",
			windows: [{ dir: "localAppData", path: "Programs\\Zed\\Zed.exe" }],
			command: "zed.exe",
		},
		{
			id: "sublime",
			label: "Sublime Text",
			kind: "app",
			windows: [{ dir: "programFiles", path: "Sublime Text\\sublime_text.exe" }],
			command: "subl.exe",
		},
		{
			id: "notepadpp",
			label: "Notepad++",
			kind: "app",
			windows: [
				{ dir: "programFiles", path: "Notepad++\\notepad++.exe" },
				{ dir: "programFilesX86", path: "Notepad++\\notepad++.exe" },
			],
		},
		{ id: "windows-terminal", label: "Windows 终端", kind: "terminal", command: "wt.exe" },
		{ id: "notepad", label: "记事本", kind: "app", windows: [{ dir: "windir", path: "notepad.exe" }] },
	],
	linux: [
		{ id: "vscode", label: "Visual Studio Code", kind: "app", command: "code" },
		{ id: "cursor", label: "Cursor", kind: "app", command: "cursor" },
		{ id: "zed", label: "Zed", kind: "app", command: "zed" },
		{ id: "sublime", label: "Sublime Text", kind: "app", command: "subl" },
		{ id: "gnome-terminal", label: "终端", kind: "terminal", command: "gnome-terminal" },
	],
};

/** What the file manager is called here, which is the one label that must not be borrowed. */
const REVEAL_LABEL: Record<string, string> = {
	darwin: "访达",
	win32: "资源管理器",
	linux: "文件管理器",
};

export function revealLabel(platform: string = process.platform): string {
	return REVEAL_LABEL[platform] ?? "文件管理器";
}

/**
 * The names the setting used to store, mapped onto ids.
 *
 * Only ever grows: an old value is a choice somebody made, and dropping it silently would move
 * them to whatever the default is without saying so. 「Finder」 lands on `reveal` because that is
 * what choosing it was always meant to do.
 */
export const ALIASES: Record<string, string> = {
	finder: "reveal",
	explorer: "reveal",
	files: "reveal",
	"visual studio code": "vscode",
	code: "vscode",
	"vs code": "vscode",
	cursor: "cursor",
	zed: "zed",
	"sublime text": "sublime",
	xcode: "xcode",
	terminal: "terminal",
	iterm: "iterm",
	"iterm2": "iterm",
	ghostty: "ghostty",
	"windows terminal": "windows-terminal",
	notepad: "notepad",
	"notepad++": "notepadpp",
};

/** An id, from whatever the settings happen to hold. */
export function resolveTargetId(stored: string | undefined | null): string {
	const value = (stored ?? "").trim();
	if (!value) return "reveal";
	if (value === "reveal") return "reveal";
	return ALIASES[value.toLowerCase()] ?? value;
}
