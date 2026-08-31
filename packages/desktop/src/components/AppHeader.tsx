/**
 * Dedicated full-width immersive title bar for Windows / Linux.
 *
 * Provides a clean unified header row across the top of the entire window (like ChatGPT / Codex desktop):
 * - Left: Navigation toggles, history back/forward, menu / project title.
 * - Center: Global draggable area for moving the window.
 * - Right: Panel action triggers and reserve padding for native minimise / maximise / close controls.
 */

import { PanelLeft } from "lucide-react";
import { useApp } from "../store.ts";
import { PanelMenu } from "./WindowToolbar.tsx";
import { WindowActionButtons } from "./WindowActionButtons.tsx";
import { SessionTabBar } from "./SessionTabBar.tsx";

export const APP_HEADER_HEIGHT = 38;

export function AppHeader({
	navOpen,
	compact,
	onToggleNav,
}: {
	navOpen: boolean;
	compact?: boolean;
	onToggleNav: () => void;
}) {
	const activeSessionId = useApp((s) => s.activeSessionId);

	return (
		<header
			className="drag-region relative z-50 flex h-[38px] w-full shrink-0 select-none items-center bg-sidebar pl-2 pr-0 text-ink-muted text-xs"
		>
			{/* Left section: Navigation toggle */}
			<div className="no-drag flex items-center shrink-0 mr-1.5">
				<button
					type="button"
					aria-label={navOpen ? "收起侧边栏" : "展开侧边栏"}
					data-ly-tip={navOpen ? "收起侧边栏" : "展开侧边栏"}
					data-ly-tip-side="bottom"
					onClick={onToggleNav}
					className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-card-hover hover:text-ink ${
						compact && navOpen ? "bg-card-hover text-ink" : "text-ink-muted"
					}`}
				>
					<PanelLeft size={16} strokeWidth={1.9} />
				</button>
			</div>

			{/* Center-left section: Tabs Bar */}
			<SessionTabBar />

			{/* Draggable space */}
			<div className="flex-1 h-full min-w-[20px]" />

			{/* Right section: Dock / Panel menu tools + Native window controls */}
			<div className="flex items-center gap-1 shrink-0">
				{activeSessionId && (
					<div className="no-drag flex items-center pr-1">
						<PanelMenu />
					</div>
				)}
				<WindowActionButtons />
			</div>
		</header>
	);
}
