/**
 * The window: a navigation pane, and a dock holding everything else.
 *
 * What is left here is the arrangement and the order things are mounted in. How the dock divides
 * itself is in `dock/`, the top edge and its buttons are in `WindowToolbar` — both of which are
 * mostly rules that were learned the hard way and are worth reading on their own.
 */

import { useEffect, useState } from "react";
import { CalendarClock, GitPullRequest, MessageSquare, Puzzle } from "lucide-react";
import { BootScreen, MIN_BOOT_MS } from "./components/BootScreen.tsx";
import { Conversation, ConversationSkeleton } from "./components/Conversation.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { ImageViewer } from "./components/image/ImageViewer.tsx";
import { InputMenu } from "./components/InputMenu.tsx";
import { Toaster } from "./components/toast/Toaster.tsx";
import { PluginsView } from "./components/PluginsView.tsx";
import { PullRequestsView } from "./components/PullRequestsView.tsx";
import { ScheduledView } from "./components/ScheduledView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SettingsShell } from "./components/settings/SettingsShell.tsx";
import { DragBand, PanelMenu, UpdateSlot, WindowButtons } from "./components/WindowToolbar.tsx";
import { DockView } from "./dock/DockView.tsx";
import { LayoutProvider, NavPane, useLayout, useSidebarFit } from "./layout.tsx";
import { sessionTitle } from "./sessionTitle.ts";
import { useShortcuts } from "./shortcuts.ts";
import { useSide } from "./sideStore.ts";
import { useApp } from "./store.ts";
import { useTrayCommands } from "./tray-commands.ts";
import { applyAppearance, watchSystemTheme } from "./theme.ts";

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

	// Before the `ready` gate below, so a command sent to a window that is still booting is not
	// dropped for the one or two frames the boot screen is up.
	useTrayCommands();

	/*
	 * The boot screen has a floor as well as a ceiling.
	 *
	 * `ready` arrives in a few hundred milliseconds, which meant the screen it gates was mounted and
	 * unmounted faster than it could fade in — the launch read as a stutter rather than as a start.
	 * Holding it for `MIN_BOOT_MS` gives it time to be seen; the timer starts with the window, so it
	 * costs nothing that the boot was not already spending.
	 */
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		const timer = window.setTimeout(() => setSettled(true), MIN_BOOT_MS);
		return () => window.clearTimeout(timer);
	}, []);

	if (!ready || !settled) return <BootScreen />;

	return (
		<LayoutProvider>
			<Shell />
			{/*
			 * One viewer for the whole window, outside the shell.
			 *
			 * Images are opened from the composer, from sent messages and from tool results, and all
			 * three want the same overlay over everything. Mounting it per call site would give a
			 * transcript with twelve screenshots in it twelve idle overlays.
			 */}
			<ImageViewer />
			{/*
			 * Cut/copy/paste for every plain text field, mounted once for the same reason.
			 *
			 * Electron draws no context menu of its own, so without this right-clicking the composer
			 * or a search box does nothing — in every window, on every screen, which is why it is
			 * here rather than attached to the fields one at a time.
			 */}
			<InputMenu />
			{/*
			 * Last, and outside the shell.
			 *
			 * A toast is frequently the answer to what the thing on top just did — a file operation
			 * refused from a menu, a save that failed behind the image viewer — so it is the one
			 * surface that has to outrank every other, including the viewer above it in this list.
			 * It does that by `TOAST_Z`, not by DOM order; being here is about it belonging to the
			 * window rather than to any one view.
			 */}
			<Toaster />
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

/**
 * What the conversation pane is called, and what it is showing.
 *
 * The pull request list, the plugin catalogue and the schedule are not conversations, but they
 * occupy the same pane: they are the main thread of whatever you are doing, and giving them a
 * pane of their own would mean the dock rearranged itself every time you glanced at a review.
 * The pane keeps its place and changes what is in it — which is exactly what it did before the
 * dock existed, when it was the `main` column.
 */
function useMainPane() {
	const view = useApp((s) => s.view);
	const meta = useApp((s) => s.meta);
	const messages = useApp((s) => s.messages);
	const loadingSession = useApp((s) => s.loadingSession);

	if (view === "pull-requests") {
		return { title: "拉取请求", icon: <GitPullRequest size={12.5} strokeWidth={1.8} />, body: <PullRequestsView /> };
	}
	if (view === "plugins") {
		return { title: "插件", icon: <Puzzle size={12.5} strokeWidth={1.8} />, body: <PluginsView /> };
	}
	if (view === "scheduled") {
		return { title: "计划任务", icon: <CalendarClock size={12.5} strokeWidth={1.8} />, body: <ScheduledView /> };
	}
	return {
		title: sessionTitle(meta?.title),
		icon: <MessageSquare size={12.5} strokeWidth={1.8} />,
		body: messages.length > 0 ? <Conversation /> : loadingSession ? <ConversationSkeleton /> : <EmptyState />,
	};
}

function ChatShell() {
	const activeSessionId = useApp((s) => s.activeSessionId);
	const workspace = useApp((s) => s.workspace);
	const { compact, navOpen, nativeFullScreen, toggleNav, dismissNav } = useLayout();
	const attach = useSide((s) => s.attach);
	const { drawn: sidebarDrawn, max: sidebarMax } = useSidebarFit();
	const main = useMainPane();

	// The side chat reads the session it is attached to, so it follows whichever one is open.
	useEffect(() => {
		void attach(activeSessionId);
	}, [activeSessionId, attach]);

	useShortcuts({ compact, navOpen, activeSessionId, workspace, toggleNav, dismissNav });

	return (
		<div className="ly-shell relative flex h-full overflow-hidden">
			<NavPane width={sidebarDrawn} maxWidth={sidebarMax} label="侧边栏">
				<Sidebar />
			</NavPane>

			{/*
			 * The draggable top edge, declared before anything that cuts a hole in it.
			 *
			 * Electron composites drag regions by walking the document in order, so a `drag` element
			 * after a `no-drag` one fills that hole straight back in. This used to sit after `main`,
			 * which was fine for as long as nothing inside `main` put controls in the top 44px — and
			 * then the pull request header did. Its buttons were drawn, were on top, passed every
			 * hit test the page can run, and did nothing at all: the press was going to the window
			 * manager as a drag.
			 *
			 * First, therefore. Everything after it — this view's own header, the panel controls,
			 * the window buttons — is a `no-drag` hole, and holes only stay open if nothing
			 * re-covers them.
			 */}
			<DragBand navOpen={navOpen && !compact} sidebarWidth={sidebarDrawn} />

			<main className="ly-opaque relative flex min-w-0 flex-1 flex-col">
				{/*
				 * The dock, holding the conversation and every panel alongside it, up to the window's
				 * top edge.
				 *
				 * There is no toolbar row above it. The first row of panes *is* the window's top row:
				 * their title bars are 44px and sit on the traffic lights' line, and the controls that
				 * used to need a strip of their own now ride on the conversation's own title bar. A
				 * separate row cost the height twice — once for the toolbar, once for the titles under
				 * it — and put the buttons on a different line from the panes they act on.
				 */}
				<DockView
					title={main.title}
					icon={main.icon}
					actions={<PanelMenu />}
					renderConversation={() => main.body}
				/>
			</main>

			{/* Always, regardless of what the dock is doing. */}
			<UpdateSlot nativeFullScreen={nativeFullScreen} />

			<WindowButtons
				nativeFullScreen={nativeFullScreen}
				navOpen={navOpen}
				compact={compact}
				onToggleNav={toggleNav}
			/>
		</div>
	);
}
