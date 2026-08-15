import {
	Check,
	Folder,
	GitCompare,
	Globe,
	ListTodo,
	MessageCirclePlus,
	Plus,
	SquareTerminal,
	X,
} from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { FileBrowser } from "./FileBrowser.tsx";
import { MenuItem, MenuLabel, Popover, usePopover } from "./Popover.tsx";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { GitPanel } from "./git/GitPanel.tsx";
import { SideChat } from "./SideChat.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import { WindowControls } from "./WindowControls.tsx";
import { useLayout } from "../layout.tsx";
import { useSide, type PanelKind } from "../sideStore.ts";
import { allPanels, type PanelDefinition } from "../panels/registry.ts";
import "../panels/builtin.tsx";
import { useApp } from "../store.ts";

/**
 * The right-hand panel: a strip of tabs over one body.
 *
 * Tabs rather than a single slot with a switcher. Both the review and the side chat are things
 * you keep an eye on across a whole session — a dropdown that swapped one for the other made
 * every glance cost two clicks, and made the thing you were not looking at feel closed rather
 * than merely behind.
 *
 * Inset rather than flush: floated off the window edge with a margin and a radius, it reads as
 * something placed beside the conversation instead of a wall the conversation stops at.
 */

/**
 * Room the traffic lights need, measured from the tab strip's own left edge.
 *
 * Only the lights. The three toolbar buttons that follow them are rendered by the strip itself
 * when it comes to the window's edge — see `WindowControls` below — so they take their space in
 * the flow rather than needing it reserved.
 *
 * 83, not the 69 the nominal geometry gives (three 12pt lights on a 20pt pitch from x=16).
 * Those numbers are what macOS documents, not what it draws: the rendered group runs several
 * points wider, and there is no API to ask. Being a few points generous costs nothing; being a
 * few points short clips the first control.
 *
 * Dropped entirely in native full screen, where macOS takes the lights away — the inset would
 * then be holding a gap open around nothing.
 */
const TRAFFIC_LIGHT_INSET = 83;

/** macOS puts its window controls top-left; Windows and Linux put theirs on the right. */
const MAC = navigator.userAgent.includes("Mac");

/**
 * The panel's nested geometry, which has exactly one solution.
 *
 * Two things have to be true at once. A tab's centre line must land at y=22, where the window's
 * own controls sit — the toolbar buttons beside it, or the traffic lights when the panel covers
 * the window. And the tab's corners must be concentric with the card's: nested rounded
 * rectangles look wrong unless the inner radius equals the outer radius minus the gap between
 * them, and that gap has to be the same above the tab as it is to its left, or the corner has
 * no single correct arc at all.
 *
 * Working back: 4px inset + 1px border + 4px gap + half of a 26px tab = 22. So the gap is 4 on
 * every side and the strip is 26 + 4 + 4 = 34 tall.
 *
 * The radius is measured from the card's *inner* edge, not its outer one. A 12px outer corner
 * on a 1px border leaves an 11px corner inside it, and the tab sits 4px in from there — so 7,
 * not 8. Change any one of these numbers and the rest have to move with it.
 */
const PANEL_INSET = 4;
const STRIP_HEIGHT = 34;
const TAB_HEIGHT = 26;
const CARD_RADIUS = 12;
const CARD_BORDER = 1;
const TAB_RADIUS = CARD_RADIUS - CARD_BORDER - PANEL_INSET;

/** How far the fade reaches in from an edge that has more tabs past it. */
const FADE = 18;

/**
 * The strip's edge treatment: only the ends that actually hide something get one.
 *
 * `undefined` rather than a no-op gradient when nothing is clipped — a mask that fades to
 * nothing at 0% still costs a compositing layer, and more to the point it would dim the first
 * tab's left edge for no reason at all.
 */
function maskFor({ start, end }: { start: boolean; end: boolean }): string | undefined {
	if (!start && !end) return undefined;
	const from = start ? `transparent 0, black ${FADE}px` : "black 0";
	const to = end ? `black calc(100% - ${FADE}px), transparent 100%` : "black 100%";
	return `linear-gradient(to right, ${from}, ${to})`;
}

export function usePanelDefinitions(): ResolvedPanel[] {
	const workspace = useApp((s) => s.workspace);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const state = { workspace: Boolean(workspace), session: Boolean(activeSessionId) };
	return allPanels().map((panel) => ({ ...panel, unavailable: panel.unavailable?.(state) }));
}

/** A panel with its availability already decided, which is all the view needs. */
export type ResolvedPanel = Omit<PanelDefinition, "unavailable"> & { unavailable?: string };

/** What a tab shows. A kind with no registered panel renders nothing rather than crashing. */
function renderPanel(kind: PanelKind) {
	const panel = allPanels().find((p) => p.kind === kind);
	if (!panel) return null;
	const Body = panel.render;
	return <Body />;
}

/**
 * The panel's first screen: pick what to put in it.
 *
 * Not an empty state and not a fallback — this is where the panel starts, and it stays until a
 * choice is made. Opening straight onto a guessed tab means guessing wrong often enough that
 * the first thing you do is close something you never asked for.
 */
function PanelChooser({
	definitions,
	onPick,
}: {
	definitions: ResolvedPanel[];
	onPick: (kind: PanelKind) => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 px-2 pb-6">
			{definitions.map((def) => (
				<button
					key={def.kind}
					type="button"
					disabled={Boolean(def.unavailable)}
					data-dw-tip={def.unavailable}
					onClick={() => onPick(def.kind)}
					className="dw-item flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px]"
				>
					<def.icon size={16} strokeWidth={1.6} className="shrink-0 text-ink-muted" />
					<span className="min-w-0 flex-1 truncate">{def.label}</span>
					<span className="shrink-0 text-[11.5px] text-ink-faint">{def.shortcut}</span>
				</button>
			))}

			{definitions.some((d) => d.unavailable) && (
				<p className="px-3 pt-3 text-[11.5px] leading-relaxed text-ink-faint">
					{definitions.find((d) => d.unavailable)?.unavailable}后可用。
				</p>
			)}
		</div>
	);
}

export function SidePanel() {
	const tabs = useSide((s) => s.tabs);
	const activeTab = useSide((s) => s.activeTab);
	const openTab = useSide((s) => s.openTab);
	const closeTab = useSide((s) => s.closeTab);
	const expanded = useSide((s) => s.expanded);
	const { compact, navOpen, nativeFullScreen, toggleNav } = useLayout();
	const adder = usePopover();

	/*
	 * True when this panel's left edge is the window's left edge, which is the only time the
	 * window's controls are over the tab strip: compact covers the whole window, and full screen
	 * reaches the edge as soon as the sidebar is out of the way.
	 */
	const atWindowEdge = compact || (expanded && !navOpen);

	const definitions = usePanelDefinitions();
	const byKind = (kind: PanelKind) => definitions.find((d) => d.kind === kind)!;

	/**
	 * Which ends of the tab strip have more beyond them.
	 *
	 * Kept as two booleans rather than a scroll offset so the mask only changes when it has to;
	 * recomputing a gradient string on every scroll frame is a lot of churn for an 18px fade.
	 */
	const strip = useRef<HTMLDivElement>(null);
	const [overflow, setOverflow] = useState({ start: false, end: false });

	const measureStrip = useCallback((el: HTMLDivElement) => {
		const start = el.scrollLeft > 1;
		const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
		setOverflow((current) => (current.start === start && current.end === end ? current : { start, end }));
	}, []);

	// The strip reflows when tabs open or close and when the panel is resized.
	useLayoutEffect(() => {
		const el = strip.current;
		if (!el) return;
		measureStrip(el);
		const observer = new ResizeObserver(() => measureStrip(el));
		observer.observe(el);
		for (const child of el.children) observer.observe(child);
		return () => observer.disconnect();
	}, [measureStrip, tabs.length]);

	const edgeMask = maskFor(overflow);

	return (
		// One inset for both layouts: the corner geometry above only works out at this value.
		<div className="relative flex h-full flex-col" style={{ padding: PANEL_INSET }}>
			{/*
			 * The card. `overflow-hidden` is what makes the radius real — without it a scroller
			 * inside paints its own square corners straight over the rounded ones.
			 */}
			{/*
			 * Same surface as the conversation, not a tinted one.
			 *
			 * A grey card next to a white column reads as a different kind of place — dimmer,
			 * secondary, something you glance at rather than work in. It is the same kind of
			 * place, so it gets the same paper; what separates it is the gap around it and a
			 * soft lift, not a change of colour and a hard rule.
			 */}
			<div
				style={{ borderRadius: CARD_RADIUS }}
				className="dw-panel flex min-h-0 flex-1 flex-col overflow-hidden border border-line-soft bg-shell"
			>
				{/*
				 * 31px, and every pixel is accounted for: 6px of outer padding, the card's 1px
				 * border, then a 26px tab centred in what is left puts the strip on the same line
				 * as the window toolbar's buttons at y=22. Draggable, so the panel's own title
				 * bar moves the window like the rest of the top edge.
				 */}
				{/*
				 * No rule under the strip. The gap between a tab and what it contains already says
				 * they are different things, and a line there was one more edge in a frame that is
				 * meant to feel like a sheet of paper rather than a set of boxes.
				 */}
				<div
					className="drag-region flex shrink-0 items-center gap-0.5 pr-1"
					style={{
						height: STRIP_HEIGHT,
						paddingLeft: atWindowEdge && MAC && !nativeFullScreen ? TRAFFIC_LIGHT_INSET : PANEL_INSET,
						paddingRight: PANEL_INSET,
					}}
				>
					{/*
					 * Scrolls rather than overflows, and fades at whichever end has more.
					 *
					 * Compact has already given 83px to the traffic lights, and four tabs do not
					 * fit in what is left of a phone-width window. The scrollbar is hidden
					 * globally, so without the fade there is nothing to say the strip slides —
					 * a tab would simply end at the edge looking like a tab that ends there.
					 */}
					{/*
					 * The window's buttons, when this panel is what covers the top-left corner.
					 *
					 * In the strip rather than over it. Left floating there they sat in a card
					 * they have nothing to do with, and the tabs had to start 172px in to clear
					 * them — a gap with three buttons hovering in it. Here they are simply the
					 * first things in the row, and the tabs follow immediately after.
					 */}
					{atWindowEdge && (
						<div className="no-drag flex shrink-0 items-center gap-0.5 pr-1">
							<WindowControls navOpen={navOpen} onToggleNav={toggleNav} active={compact && navOpen} />
						</div>
					)}

					<div
						ref={strip}
						onScroll={(e) => measureStrip(e.currentTarget)}
						style={{ maskImage: edgeMask, WebkitMaskImage: edgeMask }}
						className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
					>
					{tabs.map((kind) => {
						const def = byKind(kind);
						const active = kind === activeTab;
						return (
							<div
								key={kind}
								style={{ height: TAB_HEIGHT, borderRadius: TAB_RADIUS }}
								className={`no-drag group/tab flex min-w-0 shrink-0 items-center transition-colors duration-150 ${
									active ? "bg-card-hover" : "hover:bg-card-hover/50"
								}`}
							>
								<button
									type="button"
									onClick={() => openTab(kind)}
									data-dw-tip={def.label}
									style={{ borderRadius: TAB_RADIUS }}
									className={`flex h-full min-w-0 items-center gap-1.5 pl-2 text-[12px] ${
										active ? "pr-1 text-ink" : "pr-2 text-ink-muted"
									}`}
								>
									<def.icon size={12.5} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
									<span className="truncate">{def.label}</span>
								</button>
								{/*
								 * Only on the tab in front. A ✕ on every tab turns the strip into a row
								 * of small targets where the one you want — switching — is the harder
								 * one to hit.
								 */}
								{active && (
									<button
										type="button"
										data-dw-tip={`关闭${def.label}`}
										aria-label={`关闭${def.label}`}
										onClick={() => closeTab(kind)}
										className="mr-1 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded text-ink-faint transition-colors duration-150 hover:bg-elevated hover:text-ink"
									>
										<X size={10.5} strokeWidth={2.2} />
									</button>
								)}
							</div>
						);
					})}

					</div>

					{/*
					 * Outside the strip, so it cannot be scrolled away from.
					 *
					 * It used to be the last thing inside the tabs, which is where a new-tab button
					 * belongs right up until the tabs overflow — after that it lives past the right
					 * edge, under the fade, reachable only by scrolling a strip most people do not
					 * realise scrolls. Anchored here it holds one position at any number of tabs.
					 *
					 * Only once something is open. With no tabs the body *is* the chooser, and a
					 * button that pops up the same list a second time is just a second way to be
					 * asked the same question.
					 */}
					{tabs.length > 0 && (
						<button
							type="button"
							data-dw-tip="新建"
							aria-label="新建面板内容"
							aria-haspopup="menu"
							aria-expanded={adder.open}
							onClick={adder.toggle}
							className={`no-drag ml-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md transition-colors duration-150 ${
								adder.open ? "bg-card-hover text-ink" : "text-ink-faint hover:bg-card-hover hover:text-ink"
							}`}
						>
							<Plus size={14} strokeWidth={2} />
						</button>
					)}

					<div className="w-2 shrink-0" />

					{/*
					 * Room for the window's own buttons, which float over this strip.
					 *
					 * Full screen and close used to be drawn here. They moved to the toolbar so that
					 * they keep one position whether the panel is open or shut — what stays behind
					 * is the space they need, so nothing of this strip ends up underneath them.
					 */}
					<div className="w-[52px] shrink-0" />
				</div>

				{/*
				 * Every tab stays mounted once opened, and only the front one is shown.
				 *
				 * Unmounting would kill a terminal's shell and lose its scrollback every time you
				 * glanced at something else — the tab strip promises the others are still there,
				 * and for a running shell that promise has to be literally true.
				 */}
				<div className="relative flex min-h-0 flex-1 flex-col">
					{tabs.length === 0 && <PanelChooser definitions={definitions} onPick={openTab} />}
					{tabs.map((kind) => (
						<div key={kind} className={`flex min-h-0 flex-1 flex-col ${kind === activeTab ? "" : "hidden"}`}>
							{renderPanel(kind)}
						</div>
					))}
				</div>
			</div>

			{adder.open && (
				<Popover anchor={adder.anchor} onClose={adder.close} placement="bottom" align="start" width={216}>
					<MenuLabel>打开</MenuLabel>
					{definitions.map((def) => (
						<MenuItem
							key={def.kind}
							icon={<def.icon size={13.5} strokeWidth={1.8} />}
							hint={def.shortcut}
							disabled={Boolean(def.unavailable)}
							title={def.unavailable}
							trailing={
								tabs.includes(def.kind) ? (
									<Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" />
								) : undefined
							}
							onClick={() => {
								openTab(def.kind);
								adder.close();
							}}
						>
							{def.label}
						</MenuItem>
					))}
				</Popover>
			)}
			{/*
			 * A hole for the window's buttons, punched from this side.
			 *
			 * Electron composites drag regions in DOM order, not by z-index, and this panel comes
			 * after the toolbar. Its title bar is draggable, so it was filling the toolbar's own
			 * `no-drag` back in — the buttons were drawn on top and perfectly visible, and every
			 * click on them dragged the window instead. Declaring the same corner undraggable
			 * here, after it in the order, is what makes them clickable.
			 */}
			{/*
			 * Undraggable, and invisible to the pointer.
			 *
			 * `-webkit-app-region` is composited separately from hit testing, so this can decline
			 * clicks and still declare the corner undraggable. Without that it also swallowed
			 * every click in the area it covers — including the panel's own new-tab button, which
			 * sits right under it.
			 */}
			<div className="no-drag pointer-events-none absolute top-0 right-0 h-[44px] w-[104px]" />
		</div>
	);
}

