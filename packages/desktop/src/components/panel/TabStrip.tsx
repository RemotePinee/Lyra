/**
 * The row of tabs across the top of the side panel.
 *
 * It doubles as the panel's title bar — draggable, and when the panel reaches the window's left
 * edge it also holds the window's own controls. That is why the strip is a component rather than
 * a loop: what belongs in it changes with where the window's corner happens to be.
 *
 * No rule under it. The gap between a tab and what it contains already says they are different
 * things, and a line there was one more edge in a frame meant to feel like a sheet of paper
 * rather than a set of boxes.
 */

import { Plus, X } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PanelKind } from "../../sideStore.ts";
import { WindowControls } from "../WindowControls.tsx";
import type { ResolvedPanel } from "./definitions.tsx";
import { maskFor, MAC, PANEL_INSET, STRIP_HEIGHT, TAB_HEIGHT, TAB_RADIUS, TRAFFIC_LIGHT_INSET } from "./geometry.ts";

export function TabStrip({
	tabs,
	activeTab,
	definitions,
	atWindowEdge,
	navOpen,
	nativeFullScreen,
	compact,
	adderOpen,
	onToggleNav,
	onOpen,
	onClose,
	onToggleAdder,
}: {
	tabs: PanelKind[];
	activeTab: PanelKind | null;
	definitions: ResolvedPanel[];
	/** This panel's left edge is the window's, so the window's controls sit over this strip. */
	atWindowEdge: boolean;
	navOpen: boolean;
	nativeFullScreen: boolean;
	compact: boolean;
	adderOpen: boolean;
	onToggleNav: () => void;
	onOpen: (kind: PanelKind) => void;
	onClose: (kind: PanelKind) => void;
	onToggleAdder: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const byKind = (kind: PanelKind) => definitions.find((d) => d.kind === kind)!;

	/**
	 * Which ends of the strip have more beyond them.
	 *
	 * Kept as two booleans rather than a scroll offset so the mask only changes when it has to;
	 * recomputing a gradient string on every scroll frame is a lot of churn for an 18px fade.
	 */
	const strip = useRef<HTMLDivElement>(null);
	const [overflow, setOverflow] = useState({ start: false, end: false });

	const measure = useCallback((el: HTMLDivElement) => {
		const start = el.scrollLeft > 1;
		const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
		setOverflow((current) => (current.start === start && current.end === end ? current : { start, end }));
	}, []);

	// The strip reflows when tabs open or close and when the panel is resized.
	useLayoutEffect(() => {
		const el = strip.current;
		if (!el) return;
		measure(el);
		const observer = new ResizeObserver(() => measure(el));
		observer.observe(el);
		for (const child of el.children) observer.observe(child);
		return () => observer.disconnect();
	}, [measure, tabs.length]);

	const edgeMask = maskFor(overflow);

	return (
		<div
			className="drag-region flex shrink-0 items-center gap-0.5 pr-1"
			style={{
				height: STRIP_HEIGHT,
				paddingLeft: atWindowEdge && MAC && !nativeFullScreen ? TRAFFIC_LIGHT_INSET : PANEL_INSET,
				paddingRight: PANEL_INSET,
			}}
		>
			{/*
			 * The window's buttons, when this panel is what covers the top-left corner.
			 *
			 * In the strip rather than over it. Left floating there they sat in a card they have
			 * nothing to do with, and the tabs had to start 172px in to clear them — a gap with
			 * three buttons hovering in it. Here they are simply the first things in the row.
			 */}
			{atWindowEdge && (
				<div className="no-drag flex shrink-0 items-center gap-0.5 pr-1">
					<WindowControls navOpen={navOpen} onToggleNav={onToggleNav} active={compact && navOpen} />
				</div>
			)}

			{/*
			 * Scrolls rather than overflows, and fades at whichever end has more.
			 *
			 * Compact has already given 83px to the traffic lights, and four tabs do not fit in
			 * what is left of a phone-width window. The scrollbar is hidden globally, so without
			 * the fade there is nothing to say the strip slides — a tab would simply end at the
			 * edge looking like a tab that ends there.
			 */}
			<div
				ref={strip}
				onScroll={(e) => measure(e.currentTarget)}
				style={{ maskImage: edgeMask, WebkitMaskImage: edgeMask }}
				className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
			>
				{tabs.map((kind) => (
					<Tab
						key={kind}
						def={byKind(kind)}
						active={kind === activeTab}
						onOpen={() => onOpen(kind)}
						onClose={() => onClose(kind)}
					/>
				))}
			</div>

			{/*
			 * Outside the strip, so it cannot be scrolled away from.
			 *
			 * It used to be the last thing inside the tabs, which is where a new-tab button belongs
			 * right up until the tabs overflow — after that it lives past the right edge, under the
			 * fade, reachable only by scrolling a strip most people do not realise scrolls.
			 *
			 * Only once something is open. With no tabs the body *is* the chooser, and a button
			 * that pops up the same list again is a second way to be asked the same question.
			 */}
			{tabs.length > 0 && (
				<button
					type="button"
					data-dw-tip="新建"
					aria-label="新建面板内容"
					aria-haspopup="menu"
					aria-expanded={adderOpen}
					onClick={onToggleAdder}
					className={`no-drag ml-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md transition-colors duration-150 ${
						adderOpen ? "bg-card-hover text-ink" : "text-ink-faint hover:bg-card-hover hover:text-ink"
					}`}
				>
					<Plus size={14} strokeWidth={2} />
				</button>
			)}

			<div className="w-2 shrink-0" />

			{/*
			 * Room for the window's own buttons, which float over this strip.
			 *
			 * Full screen and close used to be drawn here. They moved to the toolbar so that they
			 * keep one position whether the panel is open or shut — what stays behind is the space
			 * they need, so nothing of this strip ends up underneath them.
			 */}
			<div className="w-[52px] shrink-0" />
		</div>
	);
}

function Tab({
	def,
	active,
	onOpen,
	onClose,
}: {
	def: ResolvedPanel;
	active: boolean;
	onOpen: () => void;
	onClose: () => void;
}) {
	return (
		<div
			style={{ height: TAB_HEIGHT, borderRadius: TAB_RADIUS }}
			className={`no-drag group/tab flex min-w-0 shrink-0 items-center transition-colors duration-150 ${
				active ? "bg-card-hover" : "hover:bg-card-hover/50"
			}`}
		>
			<button
				type="button"
				onClick={onOpen}
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
			 * Only on the tab in front. A ✕ on every tab turns the strip into a row of small
			 * targets where the one you want — switching — is the harder one to hit.
			 */}
			{active && (
				<button
					type="button"
					data-dw-tip={`关闭${def.label}`}
					aria-label={`关闭${def.label}`}
					onClick={onClose}
					className="mr-1 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded text-ink-faint transition-colors duration-150 hover:bg-elevated hover:text-ink"
				>
					<X size={10.5} strokeWidth={2.2} />
				</button>
			)}
		</div>
	);
}
