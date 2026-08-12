/**
 * Rebuild node-pty against Electron's ABI.
 *
 * node-pty is a native addon, and npm installs it compiled for the Node that ran the install —
 * a different ABI from the Electron that has to load it. Without this step the app throws
 * NODE_MODULE_VERSION on boot, and the terminal panel is the least of what breaks.
 *
 * node-gyp directly rather than `@electron/rebuild`: the latter failed to fetch headers here,
 * and this is the same thing with one moving part instead of several.
 *
 * Never fatal. A checkout without a network, or on a machine with no toolchain, should still
 * end up with a working app minus the terminal — not a failed install.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

try {
	const electron = require("electron/package.json").version;
	const ptyDir = dirname(require.resolve("node-pty/package.json"));

	execFileSync(
		"npx",
		[
			"--yes",
			"node-gyp",
			"rebuild",
			`--target=${electron}`,
			`--arch=${process.arch}`,
			"--dist-url=https://electronjs.org/headers",
		],
		{ cwd: ptyDir, stdio: "inherit" },
	);
	console.log(`node-pty rebuilt for Electron ${electron}.`);
} catch (error) {
	console.warn(
		`\nCould not rebuild node-pty for Electron: ${error instanceof Error ? error.message : String(error)}\n` +
			"The app will run; the terminal panel will not. Re-run `pnpm --filter @deepwise/desktop rebuild:pty` once the build tools are available.\n",
	);
}
