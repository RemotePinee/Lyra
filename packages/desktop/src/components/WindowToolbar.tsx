/**
 * The window's top edge: what drags it, and the buttons that float over everything.
 *
 * All three parts are here because their order in the DOM is the whole point. Electron builds the
 * draggable region by walking the document in order, so a `drag` element after a `no-drag` one
 * fills the hole back in — which is why these are rendered last in the shell, and why the band and
 * the buttons are separate elements rather than one.
 */

import { Check, MoreVertical } from "lucide-react";
import { useDock } from "../dock/store.ts";
import { has } from "../dock/tree.ts";
import { usePanelDefinitions } from "../panels/definitions.tsx";
import type { PanelKind } from "../sideStore.ts";
import { MenuBody, MenuItem, MenuLabel, Popover, usePopover } from "./Popover.tsx";
import { ToolbarButton, WINDOW_CONTROLS_LEFT, WindowControls } from "./WindowControls.tsx";

/** Left offset of the first toolbar button, when there are traffic lights to clear. */
const TOOLBAR_LEFT = WINDOW_CONTROLS_LEFT;



/**
 * And where it goes when there are none.
 *
 * macOS takes the lights away in native full screen. Holding their inset open then leaves a gap at
 * the top-left reserved for three buttons that are not there — which is exactly what it looks
 * like. 12 is the same margin the rest of the window's edges use.
 */
const TOOLBAR_LEFT_FULLSCREEN = 12;

/*
 * The update chip used to have a slot of its own here, just past the sidebar toggle.
 *
 * It has moved to the end of the sidebar's bottom row, where it is a dot that opens on hover.
 * Nothing about the toolbar was wrong for it except the size of the claim: the corner of the
 * window is where the window's own controls are, and a version number is not one of them.
 */

/**
 * The strip of window that can be dragged to move it.
 *
 * As wide as the navigation and no wider, which is a change: it used to span the window. The dock
 * now reaches the top edge, and every pane's title bar is up there — a full-width band would claim
 * all of them, so pressing a pane's title would move the window instead of the pane.
 *
 * With the navigation closed it shrinks to the corner the traffic lights need, which is the only
 * part of that row that is still the window's rather than a pane's.
 */
export function DragBand({ navOpen, sidebarWidth }: { navOpen: boolean; sidebarWidth: number }) {
	return (
		<div
			className="drag-region absolute top-0 left-0 z-40 h-[44px]"
			style={{ width: navOpen ? sidebarWidth : WINDOW_CONTROLS_LEFT }}
		/>
	);
}

/**
 * The panels that get a button of their own, in the order they sit in.
 *
 * A shortlist, not the whole registry. These are the three you reach for while working — a shell,
 * a page, the diff — and reaching for them through two clicks of a menu is two clicks too many.
 * Everything else, including anything a plugin contributes, is in the menu beside them, which is
 * also where these three appear when they cannot be opened.
 */
const QUICK: PanelKind[] = ["terminal", "browser", "review"];

/**
 * Which panels are in the window: three buttons and a menu.
 *
 * Rendered *inside the conversation pane's own title bar* rather than in a toolbar of its own.
 * A toolbar cost a whole row of the window and put these buttons on a different line from the pane
 * titles they act on — two strips where the reference has one.
 *
 * This is also all that is left of what used to be three separate controls: a panel toggle, a
 * full-screen toggle, and the tab strip's add button. The dock removed the questions they answered
 * — there is no panel to open or collapse, and no full screen distinct from a pane being large.
 */
export function PanelMenu() {
	const menu = usePopover();
	const definitions = usePanelDefinitions();
	const tree = useDock((s) => s.tree);
	const open = useDock((s) => s.open);
	const close = useDock((s) => s.close);

	const toggle = (kind: PanelKind) => (has(tree, kind) ? close(kind) : open(kind));

	return (
		<>
			<div className="flex items-center gap-0.5">
				{QUICK.map((kind) => {
					const def = definitions.find((entry) => entry.kind === kind);
					// Absent rather than disabled when it cannot be opened: a row of greyed buttons
					// is a row of things you have to read before you can ignore them. The menu still
					// lists them, with the reason.
					if (!def || def.unavailable) return null;
					return (
						<ToolbarButton
							key={kind}
							label={`${def.label} ${def.shortcut}`}
							active={has(tree, kind)}
							onClick={() => toggle(kind)}
						>
							<def.icon size={13} strokeWidth={1.9} />
						</ToolbarButton>
					);
				})}

				{/* The overflow mark every toolbar uses for "the rest of it". */}
				<ToolbarButton label="面板" onClick={menu.toggle} active={menu.open}>
					<MoreVertical size={15} strokeWidth={2} />
				</ToolbarButton>
			</div>

			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="default">
					<MenuBody>
						<MenuLabel>面板</MenuLabel>
						{definitions.map((def) => {
							const shown = has(tree, def.kind);
							return (
								<MenuItem
									key={def.kind}
									icon={<def.icon size={13.5} strokeWidth={1.8} />}
									hint={def.shortcut}
									disabled={Boolean(def.unavailable)}
									title={def.unavailable}
									// A tick, not a highlight: this is a set of things that are either
									// in the window or not, and every row is independently either.
									trailing={shown ? <Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" /> : undefined}
									onClick={() => {
										if (shown) close(def.kind);
										else open(def.kind);
										menu.close();
									}}
								>
									{def.label}
								</MenuItem>
							);
						})}
					</MenuBody>
				</Popover>
			)}
		</>
	);
}

/**
 * The window's own controls: the traffic lights' neighbour, and nothing else.
 *
 * Unconditional now. This used to be rendered only when no panel was covering the window's corner,
 * because in that case the panel drew its own copy inside its tab strip — a handover that had to
 * be delayed by exactly the length of the panel's slide, or the buttons appeared riding its edge
 * and swept 450px across the window. The dock puts every pane below the toolbar, so the corner is
 * the sidebar's or the toolbar's and never changes hands.
 */
export function WindowButtons({
	nativeFullScreen,
	navOpen,
	compact,
	onToggleNav,
}: {
	nativeFullScreen: boolean;
	navOpen: boolean;
	compact: boolean;
	onToggleNav: () => void;
}) {
	return (
		<div
			className="no-drag absolute top-0 z-[60] flex h-[44px] items-center gap-0.5"
			style={{ left: nativeFullScreen ? TOOLBAR_LEFT_FULLSCREEN : TOOLBAR_LEFT }}
		>
			<WindowControls navOpen={navOpen} onToggleNav={onToggleNav} active={compact && navOpen} />
		</div>
	);
}
