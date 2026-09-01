import { contextBridge, ipcRenderer } from "electron";
import type { LyraApi } from "./ipc-types.ts";

function keepDocumentTransparent(): void {
	const apply = () => {
		for (const surface of [document.documentElement, document.body, document.getElementById("root")]) {
			if (!surface) continue;
			surface.style.setProperty("background", "transparent", "important");
			surface.style.setProperty("background-color", "transparent", "important");
		}
	};
	apply();
	document.addEventListener("DOMContentLoaded", apply, { once: true });
}

keepDocumentTransparent();

type ScreenshotBridge = Pick<LyraApi["screenshot"], "finish" | "cancel" | "onInit" | "ready">;

const screenshot: ScreenshotBridge = {
	finish: (dataUrl, settings) => ipcRenderer.invoke("screenshot:finish", dataUrl, settings),
	cancel: () => ipcRenderer.invoke("screenshot:cancel"),
	onInit: (handler) => {
		const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof handler>[0]) => handler(payload);
		ipcRenderer.on("screenshot:init", listener);
		return () => ipcRenderer.removeListener("screenshot:init", listener);
	},
	ready: () => ipcRenderer.send("screenshot:ready"),
};

// The capture renderer gets no workspace, session, shell, settings, or filesystem capabilities.
contextBridge.exposeInMainWorld("lyra", { screenshot });
