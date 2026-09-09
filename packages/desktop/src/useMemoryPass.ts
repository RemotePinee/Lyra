/** Idle extraction runs only when explicitly enabled in settings. */

import { useEffect } from "react";
import { useApp } from "./store.ts";

/** 一轮结束之后，等多久算「空闲」。 */
export const IDLE_MS = 5 * 60 * 1000;

/**
 * 挂一次，管整个窗口。
 * Extraction is opt-in; opening the app must never change a saved preference.
 */
export function useMemoryPass(): void {
	const cwd = useApp((s) => s.workspace?.path ?? null);
	const running = useApp((s) => s.running);
	const notify = useApp((s) => s.notify);
	const enabled = useApp(
		(s) =>
			s.settings?.memoryExtraction === true &&
			(s.settings?.personalization?.enableProjectMemory ?? s.settings?.personalization?.enableMemory) !== false,
	);

	useEffect(() => {
		if (!cwd || running || !enabled) return;
		let cancelled = false;

		const timer = window.setTimeout(async () => {
			if (!window.lyra.projectMemory?.status || !window.lyra.projectMemory?.extract) return;
			const status = await window.lyra.projectMemory.status(cwd).catch(() => null);
			if (cancelled || !status?.run) return;

			const result = await window.lyra.projectMemory.extract(cwd).catch(() => null);
			/*
			 * 只有真的写了东西才说话。
			 *
			 * 「这几次会话里没什么值得记的」是一个正确的结果，而且是最常见的那个——把它也报出来，
			 * 就是每天一条关于什么都没发生的通知。
			 */
			if (!cancelled && result?.memory) notify(`更新了这个项目的记忆，读了 ${result.sessions} 次会话`);
		}, IDLE_MS);

		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [cwd, running, notify, enabled]);
}
