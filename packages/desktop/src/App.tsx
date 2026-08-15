/**
 * The window: a navigation pane, a conversation, and a panel beside it.
 *
 * What is left here is the arrangement and the order things are mounted in. How the three panes
 * divide the width is in `usePanelLayout`, the top edge and its buttons are in `WindowToolbar` —
 * both of which are mostly rules that were learned the hard way and are worth reading on their own.
 */

import { useEffect } from "react";
import { BootScreen } from "./components/BootScreen.tsx";
import { Conversation, ConversationSkeleton } from "./components/Conversation.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { NoticeStack } from "./components/NoticeStack.tsx";
import { PullRequestsView } from "./components/PullRequestsView.tsx";
import { ResizeHandle } from "./components/ResizeHandle.tsx";
import { ScheduledView } from "./components/ScheduledView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SidePanel } from "./components/SidePanel.tsx";
import { SettingsShell } from "./components/settings/SettingsShell.tsx";
import { DragBand, PanelControls, WindowButtons } from "./components/WindowToolbar.tsx";
import { LayoutProvider, NavPane, SidePane, useLayout } from "./layout.tsx";
import { useShortcuts } from "./shortcuts.ts";
import { useSide } from "./sideStore.ts";
import { useApp } from "./store.ts";
import { applyAppearance, watchSystemTheme } from "./theme.ts";
import { usePanelLayout } from "./usePanelLayout.ts";

export function App() {
	const ready = useApp((s) => s.ready);
	const bootstrap = useApp((s) => s.bootstrap);

	useEffect(() => {
		void bootstrap();
	}, [bootstrap]);

	const appearance = useApp((s) => s.settings?.appearance);
	useEffect(() => {
		if (appearance) applyAppearance(appearance);
	}, [appearance]);
	useEffect(() => watchSystemTheme(() => useApp.getState().settings?.appearance ?? appearance!), [appearance]);

	if (!ready) return <BootScreen />;

	return (
		<LayoutProvider>
			<Shell />
		</LayoutProvider>
	);
}

function Shell() {
	const view = useApp((s) => s.view);
	const { dismissNav } = useLayout();

	// Settings and the workspace each own a navigation pane; a drawer opened over one has no
	// meaning over the other, so leaving the view puts it away.
	useEffect(() => dismissNav(), [view, dismissNav]);

	if (view === "settings") return <SettingsShell />;
	return <ChatShell />;
}

function ChatShell() {
	const view = useApp((s) => s.view);
	const messages = useApp((s) => s.messages);
	const loadingSession = useApp((s) => s.loadingSession);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const workspace = useApp((s) => s.workspace);
	const { compact, navOpen, nativeFullScreen, sidebarWidth, bounds, setPanelWidth, resetPanelWidth, toggleNav, dismissNav } =
		useLayout();

	const panelOpen = useSide((s) => s.panelOpen);
	const expanded = useSide((s) => s.expanded);
	const reopenPanel = useSide((s) => s.reopenPanel);
	const closePanel = useSide((s) => s.closePanel);
	const toggleTab = useSide((s) => s.toggleTab);
	const toggleExpanded = useSide((s) => s.toggleExpanded);
	const attach = useSide((s) => s.attach);

	const { panelWidth, panelMax, fullScreen, panelHostsControls, openPanel } = usePanelLayout();

	// The side chat reads the session it is attached to, so it follows whichever one is open.
	useEffect(() => {
		void attach(activeSessionId);
	}, [activeSessionId, attach]);

	// Two full-window panels cannot share one window; the newest one wins.
	useEffect(() => {
		if (compact && navOpen) closePanel();
	}, [compact, navOpen, closePanel]);

	useShortcuts({
		compact,
		navOpen,
		panelOpen,
		expanded,
		activeSessionId,
		workspace,
		toggleNav,
		dismissNav,
		closePanel,
		toggleExpanded,
		openPanel,
		toggleTab,
	});

	return (
		<div className="dw-shell relative flex h-full overflow-hidden">
			<NavPane width={sidebarWidth} label="侧边栏">
				<Sidebar />
			</NavPane>

			<main className="dw-opaque relative flex min-w-0 flex-1 flex-col">
				{/* Space for the window toolbar, which is rendered last so its no-drag holes stick. */}
				<div className="h-[44px] shrink-0" />

				<div className="relative flex min-h-0 flex-1">
					<div className="flex min-w-0 flex-1 flex-col">
						{view === "pull-requests" ? (
							<PullRequestsView />
						) : view === "scheduled" ? (
							<ScheduledView />
						) : messages.length > 0 ? (
							<Conversation />
						) : loadingSession ? (
							<ConversationSkeleton />
						) : (
							<EmptyState />
						)}
					</div>
				</div>

				<NoticeStack />
			</main>

			{/*
			 * The top edge, and then the panel, in this order and last.
			 *
			 * Electron composites drag regions by DOM order, so a `drag` element after a `no-drag`
			 * one fills the hole back in. The sidebar's own drag strip used to come later than this
			 * toolbar, which is why its buttons could not be clicked at all.
			 */}
			<DragBand />
			<PanelControls
				compact={compact}
				navOpen={navOpen}
				panelOpen={panelOpen}
				expanded={expanded}
				onToggleExpanded={toggleExpanded}
				onTogglePanel={() => (panelOpen ? closePanel() : openPanel(() => reopenPanel()))}
			/>

			{/*
			 * Being last in the DOM costs nothing in the wide layout: the toolbar is absolute and
			 * takes no part in the flex row, so this is still the third and rightmost item.
			 */}
			<SidePane width={panelWidth} open={panelOpen} fullScreen={fullScreen} offset={navOpen ? sidebarWidth : 0}>
				<SidePanel />

				{/*
				 * Not in compact or full screen, where the panel covers the column rather than
				 * sharing it: there is no boundary between two things to move. Nor while closed —
				 * the pane is still mounted then, and an edge with nothing on one side of it is
				 * not an edge.
				 */}
				{panelOpen && !compact && !fullScreen && (
					<ResizeHandle
						edge="start"
						width={panelWidth}
						min={bounds.panel.min}
						max={panelMax}
						onResize={setPanelWidth}
						onReset={resetPanelWidth}
						label="调整面板宽度"
					/>
				)}
			</SidePane>

			{!panelHostsControls && (
				<WindowButtons
					nativeFullScreen={nativeFullScreen}
					navOpen={navOpen}
					compact={compact}
					onToggleNav={toggleNav}
				/>
			)}
		</div>
	);
}
