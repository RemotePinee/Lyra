/**
 * The right-hand panel: a strip of tabs over one body.
 *
 * Tabs rather than a single slot with a switcher. Both the review and the side chat are things you
 * keep an eye on across a whole session — a dropdown that swapped one for the other made every
 * glance cost two clicks, and made the thing you were not looking at feel closed rather than
 * merely behind.
 *
 * Inset rather than flush: floated off the window edge with a margin and a radius, it reads as
 * something placed beside the conversation instead of a wall the conversation stops at. The exact
 * numbers are in `panel/geometry`, where they can be derived rather than guessed at.
 */

import { Check } from "lucide-react";
import { useLayout } from "../layout.tsx";
import { useSide } from "../sideStore.ts";
import { MenuItem, MenuLabel, Popover, usePopover } from "./Popover.tsx";
import { renderPanel, usePanelDefinitions } from "./panel/definitions.tsx";
import { CARD_RADIUS, PANEL_INSET } from "./panel/geometry.ts";
import { PanelChooser } from "./panel/PanelChooser.tsx";
import { TabStrip } from "./panel/TabStrip.tsx";

export function SidePanel() {
	const tabs = useSide((s) => s.tabs);
	const activeTab = useSide((s) => s.activeTab);
	const openTab = useSide((s) => s.openTab);
	const closeTab = useSide((s) => s.closeTab);
	const expanded = useSide((s) => s.expanded);
	const { compact, navOpen, nativeFullScreen, toggleNav } = useLayout();
	const adder = usePopover();
	const definitions = usePanelDefinitions();

	/*
	 * True when this panel's left edge is the window's left edge, which is the only time the
	 * window's controls are over the tab strip: compact covers the whole window, and full screen
	 * reaches the edge as soon as the sidebar is out of the way.
	 */
	const atWindowEdge = compact || (expanded && !navOpen);

	return (
		// One inset for both layouts: the corner geometry only works out at this value.
		<div className="relative flex h-full flex-col" style={{ padding: PANEL_INSET }}>
			{/*
			 * The card. `overflow-hidden` is what makes the radius real — without it a scroller
			 * inside paints its own square corners straight over the rounded ones.
			 *
			 * Same surface as the conversation, not a tinted one. A grey card next to a white
			 * column reads as a different kind of place — dimmer, secondary, something you glance
			 * at rather than work in. It is the same kind of place, so it gets the same paper;
			 * what separates it is the gap around it and a soft lift, not a change of colour.
			 */}
			<div
				style={{ borderRadius: CARD_RADIUS }}
				className="dw-panel flex min-h-0 flex-1 flex-col overflow-hidden border border-line-soft bg-shell"
			>
				<TabStrip
					tabs={tabs}
					activeTab={activeTab}
					definitions={definitions}
					atWindowEdge={atWindowEdge}
					navOpen={navOpen}
					nativeFullScreen={nativeFullScreen}
					compact={compact}
					adderOpen={adder.open}
					onToggleNav={toggleNav}
					onOpen={openTab}
					onClose={closeTab}
					onToggleAdder={adder.toggle}
				/>

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
								tabs.includes(def.kind) ? <Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" /> : undefined
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
			 * click on them dragged the window instead. Declaring the same corner undraggable here,
			 * after it in the order, is what makes them clickable.
			 *
			 * Undraggable, and invisible to the pointer. `-webkit-app-region` is composited
			 * separately from hit testing, so this can decline clicks and still declare the corner
			 * undraggable. Without that it also swallowed every click in the area it covers —
			 * including the panel's own new-tab button, which sits right under it.
			 */}
			<div className="no-drag pointer-events-none absolute top-0 right-0 h-[44px] w-[104px]" />
		</div>
	);
}
