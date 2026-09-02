/**
 * Usage, over IPC.
 *
 * One handler, and it is deliberately dumb: it hands back the whole day-by-model table and lets
 * the page decide what a range or a ranking is. The alternative — a handler per question — would
 * put the arithmetic on the far side of a process boundary where it cannot be tested without
 * booting Electron.
 *
 * In flight at most once. The first scan of a large home takes a couple of seconds, and opening
 * the page twice while it runs should wait for the answer rather than start a second read of the
 * same 264MB.
 */

import { ipcMain } from "electron";
import { scanUsage, type UsageScan } from "../usage-scan.ts";

let inFlight: Promise<UsageScan> | null = null;

export function registerUsageIpc(): void {
	ipcMain.handle("usage:scan", async () => {
		if (!inFlight) {
			inFlight = scanUsage().finally(() => {
				inFlight = null;
			});
		}
		return inFlight;
	});
}
