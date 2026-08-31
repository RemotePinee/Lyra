import { useEffect, useState } from "react";

/**
 * Native-feeling window controls (Minimize, Maximize/Restore, Close) for Windows & Linux.
 *
 * Rendered inline inside AppHeader / SettingsHeader without Electron titleBarOverlay limitations,
 * completely eliminating layer clipping, border obscuration, and theme lag.
 */
export function WindowActionButtons() {
	const [maximized, setMaximized] = useState(false);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void window.lyra?.windowControls?.isMaximized?.().then((isMax) => {
			if (typeof isMax === "boolean") setMaximized(isMax);
		});
		if (window.lyra?.windowControls?.onMaximizedChange) {
			unlisten = window.lyra.windowControls.onMaximizedChange(setMaximized);
		}
		return () => {
			unlisten?.();
		};
	}, []);

	const handleMinimize = () => {
		void window.lyra?.windowControls?.minimize?.();
	};

	const handleMaximize = () => {
		void window.lyra?.windowControls?.maximize?.();
	};

	const handleClose = () => {
		void window.lyra?.windowControls?.close?.();
	};

	return (
		<div className="no-drag flex h-full items-center">
			<button
				type="button"
				aria-label="最小化"
				onClick={handleMinimize}
				className="flex h-[38px] w-[46px] items-center justify-center text-ink-muted transition-colors hover:bg-card-hover hover:text-ink active:bg-elevated"
			>
				{/* Native Windows minimize glyph */}
				<svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
					<rect width="10" height="1" />
				</svg>
			</button>

			<button
				type="button"
				aria-label={maximized ? "向下还原" : "最大化"}
				onClick={handleMaximize}
				className="flex h-[38px] w-[46px] items-center justify-center text-ink-muted transition-colors hover:bg-card-hover hover:text-ink active:bg-elevated"
			>
				{maximized ? (
					/* Native Windows restore glyph */
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
						<path d="M2.5 7.5H1.5V1.5H7.5V2.5" />
						<rect x="2.5" y="2.5" width="6" height="6" />
					</svg>
				) : (
					/* Native Windows maximize glyph */
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
						<rect x="1" y="1" width="8" height="8" />
					</svg>
				)}
			</button>

			<button
				type="button"
				aria-label="关闭"
				onClick={handleClose}
				className="flex h-[38px] w-[46px] items-center justify-center text-ink-muted transition-colors hover:bg-[#e81123] hover:text-white active:bg-[#c40e1e]"
			>
				{/* Native Windows close glyph */}
				<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
					<path d="M1 1L9 9M9 1L1 9" />
				</svg>
			</button>
		</div>
	);
}
