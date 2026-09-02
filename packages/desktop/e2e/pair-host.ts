/* oxlint-disable no-console -- probe CLI that prints the pairing details it is holding open */
/**
 * A desktop with sync switched on, held open so a phone can pair with it.
 *
 * `node e2e/pair-host.ts` — prints the address, the token and the pairing code, then waits. The
 * point is the other end: everything here is already covered by unit tests, and none of it proves
 * that a phone on the same network can actually connect, authenticate and read a session.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp } from "./app.ts";

const PORT = Number(process.argv[2] ?? 4593);

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "readme.md"), "# 配对测试用的项目\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "pair", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "",
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			/*
			 * A fixed token, so a phone paired once stays paired across restarts of this probe.
			 * Re-pairing by hand between every check is most of the time a manual test takes.
			 */
			sync: { enabled: true, port: PORT, token: "1111111111111111111111111111abcd" },
			editor: { defaultOpenTarget: "Zed", showBottomPanel: true },
			appearance: { theme: "dark" },
		}),
	);
}

const app = await startApp({ port: 9464, seed });
try {
	await new Promise((r) => setTimeout(r, 2500));
	const status = await app.evaluate<string>(`window.lyra.sync.status().then((s) => JSON.stringify(s))`);
	const parsed = JSON.parse(status) as { running: boolean; port: number; token: string; addresses: string[] };
	console.log(JSON.stringify({ running: parsed.running, port: parsed.port, token: parsed.token, addresses: parsed.addresses }));
	console.log(`PAIRING_CODE lyra://pair?host=${parsed.addresses[0]}&port=${parsed.port}&token=${parsed.token}`);
	console.log("HOLDING — 按 Ctrl-C 结束");
	// Held open: the phone connects to this process.
	await new Promise(() => {});
} finally {
	await app.stop();
}
