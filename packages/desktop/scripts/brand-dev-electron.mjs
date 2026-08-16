/**
 * Make the development app say "Lyra" in the dock.
 *
 * `app.setName()` cannot do this, and it is worth being precise about why. In development the
 * process running is Electron's own prebuilt `Electron.app`, and macOS reads the dock tooltip,
 * the menu bar's application menu and the force-quit list straight out of that bundle's
 * `Info.plist` — before any JavaScript exists to have an opinion. `setName()` changes what the
 * app calls itself at runtime, which affects `app.getName()` and the userData path; it does not
 * reach the bundle metadata the window server already read.
 *
 * So the bundle is what has to change. Packaged builds get their name from electron-builder and
 * never come through here; this is only about not staring at "Electron" all day while working.
 *
 * Idempotent, and a no-op off macOS. `node_modules` is disposable, so this runs from
 * `postinstall` and again before `dev` — a reinstall silently restores the stock plist, and
 * without the second call the name comes back the next time someone installs a dependency.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const NAME = "Lyra";
const LSREGISTER =
	"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

if (process.platform !== "darwin") process.exit(0);

const require = createRequire(import.meta.url);

/** The executable inside the bundle, from which the bundle itself is two levels up. */
let executable;
try {
	executable = require("electron");
} catch {
	// Electron is not installed yet — postinstall ordering, or a CI job that never launches it.
	process.exit(0);
}

if (typeof executable !== "string") process.exit(0);

const contents = dirname(dirname(executable)); // …/Electron.app/Contents/MacOS/Electron → …/Contents
const plist = join(contents, "Info.plist");
const bundle = dirname(contents);

if (!existsSync(plist)) process.exit(0);

const read = (key) => {
	try {
		return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
};

const renamed = read("CFBundleName") !== NAME;

if (renamed) {
	for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
		// `Set` fails on a key that does not exist, so fall back to adding it.
		try {
			execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${NAME}`, plist]);
		} catch {
			try {
				execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${NAME}`, plist]);
			} catch {
				// A read-only store or a plist shape we do not recognise: the name is cosmetic, so
				// losing it must never be what stops the app from starting.
			}
		}
	}
}

/*
 * Re-register the bundle, which is the step that actually makes the name appear.
 *
 * LaunchServices reads a bundle's metadata once and keeps it in a database of its own, keyed by
 * path. Editing the plist does not invalidate that record and neither does relaunching the app:
 * the dock, ⌘-tab and the menu bar go on saying "Electron" from what was written the first time
 * the bundle was seen. Touching the directory does not help either — the cache is not
 * mtime-driven. `lsregister -f` forces the re-read for this one bundle.
 *
 * Unconditional, unlike the rename above. The plist is on disk and survives; this record is not
 * ours and can be rebuilt without warning, and at ~60ms it is not worth being clever about. The
 * rename is the part that is idempotent; this is the part that makes it true again.
 */
try {
	execFileSync(LSREGISTER, ["-f", bundle], { stdio: "ignore" });
} catch {
	// Present on every macOS this runs on, but the name is cosmetic: never fail the build for it.
}

if (renamed) console.log(`[brand] development Electron bundle now named ${NAME}`);
