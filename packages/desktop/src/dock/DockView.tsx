/**
 * The dock: every pane in the window except the navigation, arranged by the tree.
 *
 * Two rules hold this together, and both exist to keep a pane's contents alive across a
 * rearrangement — a terminal's shell, a page in the browser, an editor's undo history.
 *
 * **One flat list of panes, positioned absolutely.** Never a recursive render of the tree; see
 * the note at the top of `layout.ts`.
 *
 * **One DOM shape for both window sizes.** The narrow form is the same panes, each laid over the
 * whole dock with all but one hidden — not a different component. A layout that swaps its
 * structure at a breakpoint unmounts everything inside it, which is how this app has previously
 * shipped a transition that was a hard cut, and how it would now ship a terminal that dies when
 * you make the window small.
 */

import { useLayoutEffect, useRef } from "react";

import { useLayout } from "../layout.tsx";
import { WINDOW_CONTROLS_LEFT } from "../components/WindowControls.tsx";
import { useApp } from "../store.ts";
import { renderPanel, usePanelDefinitions } from "../panels/definitions.tsx";
import { CollapsedBar, type CollapsedItem } from "./CollapsedBar.tsx";
import { pct } from "./css.ts";
import { HEADER_PAD, paneFloor } from "./geometry.ts";
import { DockPane } from "./DockPane.tsx";
import { Splitter } from "./Splitter.tsx";
import { fitTree, layoutPanes, layoutSplitters, type Box } from "./layout.ts";
import { useDock } from "./store.ts";
import type { PaneKind } from "./tree.ts";
import { useBoxSize } from "./useBoxSize.ts";
import { useDockDrag } from "./useDockDrag.ts";

const WHOLE: Box = { left: 0, top: 0, width: 1, height: 1 };

/**
 * How far a pane's title must start in when it is the one covering the traffic lights.
 *
 * `WINDOW_CONTROLS_LEFT` is measured from the window's edge. A pane at the left edge is flush with
 * it, so what stands between the two is the card's border and the header's own padding — subtract
 * those and what is left is the extra the header has to add.
 */
const TRAFFIC_LIGHTS = WINDOW_CONTROLS_LEFT - HEADER_PAD - 1;

export function DockView({
	title,
	icon,
	actions,
	renderConversation,
}: {
	/** The conversation's title, which is the session's rather than a fixed word. */
	title: string;
	icon?: React.ReactNode;
	/** The window's panel controls, which ride on the conversation's own title bar. */
	actions?: React.ReactNode;
	renderConversation: () => React.ReactNode;
}) {
	const tree = useDock((s) => s.tree);
	const focused = useDock((s) => s.focused);
	const maximized = useDock((s) => s.maximized);
	const { compact, navOpen, nativeFullScreen } = useLayout();
	const definitions = usePanelDefinitions();
	const workspace = useApp((s) => s.workspace);

	const containerRef = useRef<HTMLDivElement>(null);
	const { carried, start, landed } = useDockDrag(containerRef);
	const size = useBoxSize(containerRef);

	/*
	 * Point the dock at the project, which loads that project's saved layout.
	 *
	 * A *layout* effect, not an ordinary one, and that is a visible difference rather than a
	 * stylistic preference. An ordinary effect runs after the browser has painted, so the first
	 * frame of every launch showed the default layout and the second showed the saved one — the
	 * panes you arranged appearing to snap into place a frame after the window opened. Reading
	 * storage is synchronous, so there is nothing to wait for and no reason to paint first.
	 *
	 * Keyed on the path alone. `definitions` is rebuilt on every render, so depending on it would
	 * run this constantly — it is read through a ref instead, and only its contents matter here
	 * (which kinds are loadable), never its identity.
	 */
	const allowed = useRef<PaneKind[]>([]);
	allowed.current = ["conversation", ...definitions.map((def) => def.kind)];
	const path = workspace?.path ?? null;
	useLayoutEffect(() => {
		/*
		 * Adopting a layout is not a movement, so it does not animate.
		 *
		 * The panes animate between arrangements because one arrangement became another and the
		 * eye should be able to follow it. Loading a stored layout is not that: nothing moved, this
		 * is simply where things are. Left to transition it read as the window assembling itself —
		 * every launch began with the default layout and slid into the saved one, and every project
		 * switch slid from the last project's arrangement into this one's, as though the panes had
		 * travelled between two unrelated places.
		 */
		document.documentElement.dataset.dockSettling = "";
		useDock.getState().adopt(path, allowed.current);
		const frame = requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				delete document.documentElement.dataset.dockSettling;
			});
		});
		return () => cancelAnimationFrame(frame);
	}, [path]);

	/*
	 * The tree as stored, and the tree as it should be drawn at this window size.
	 *
	 * `fitted` is the one everything here uses — the panes, the splitters, and the drag's hit test —
	 * because it is what is on screen, and a handle that did not sit on the boundary it moves would
	 * be unusable. `tree` keeps the shares that were actually dragged to, so widening the window
	 * returns the layout to them rather than to whatever a narrow window forced.
	 */
	const fitted = compact || !size ? tree : fitTree(tree, size, paneFloor);
	const boxes = layoutPanes(fitted);
	const splitters = compact ? [] : layoutSplitters(fitted);

	/*
	 * The order panes are *mounted* in, which is not the order they are laid out in.
	 *
	 * React keys stop a moved pane from being recreated, but they do not stop it being moved in
	 * the DOM — and moving an <iframe> or a <webview> reloads it, which is the same loss by
	 * another route. Appending new panes and never reordering means an existing pane's DOM node
	 * is only ever removed, never relocated.
	 *
	 * Assigned during render and idempotent, so a double render under StrictMode produces the
	 * same list rather than a duplicated one.
	 */
	const order = useRef<PaneKind[]>([]);
	const present = boxes.map((box) => box.kind);
	/*
	 * A carried pane is *not in the tree* — it has been lifted out, and the panes staying put have
	 * closed over the space it left. It is still mounted, obviously: it is the thing in your hand.
	 * Counting it as live keeps it in the mounting order too, so putting a terminal down does not
	 * append it to the end of the list and relocate every DOM node after it.
	 */
	const live = carried && !present.includes(carried.kind) ? [...present, carried.kind] : present;
	order.current = [
		...order.current.filter((kind) => live.includes(kind)),
		...live.filter((kind) => !order.current.includes(kind)),
	];

	const describe = (kind: PaneKind) => {
		if (kind === "conversation") return { label: title, icon };
		const def = definitions.find((entry) => entry.kind === kind);
		return { label: def?.label ?? kind, icon: def ? <def.icon size={12.5} strokeWidth={1.8} /> : undefined };
	};

	const items: CollapsedItem[] = present.map((kind) => ({ kind, ...describe(kind) }));

	/*
	 * Which pane, if any, has to make room for the traffic lights.
	 *
	 * With the sidebar open — which is almost always — the answer is none: the sidebar covers that
	 * corner and draws the lights' inset itself. Closed, the corner belongs to whichever pane is at
	 * the very top-left, and only that one. Native full screen takes the lights away entirely.
	 *
	 * This is the whole of what used to be a delayed handover of the window's own buttons between
	 * the toolbar and the panel — 220ms of it, timed to a slide. A pane either starts at the
	 * origin or it does not.
	 */
	const corner =
		navOpen || compact || nativeFullScreen
			? null
			: (boxes.find((box) => box.left === 0 && box.top === 0)?.kind ?? null);

	return (
		<div className="ly-dock relative flex min-h-0 min-w-0 flex-1 flex-col">
			{compact && <CollapsedBar items={items} focused={focused} onFocus={(kind) => useDock.getState().focus(kind)} />}

			{/* Marked so the drop geometry can be measured from outside — see `e2e/dock.test.ts`. */}
			<div ref={containerRef} data-dock-panes className="relative min-h-0 min-w-0 flex-1">
				{splitters.map((handle) => (
					<Splitter
						key={`${handle.path.join(".")}:${handle.index}`}
						handle={handle}
						containerRef={containerRef}
						onResize={(share) => useDock.getState().setShare(handle.path, handle.index, share)}
						onEven={() => useDock.getState().setShare(handle.path, handle.index, handle.pair / 2)}
					/>
				))}

				{/*
				 * Where the carried pane would land.
				 *
				 * The panes staying put have already rearranged to make room, which leaves that room
				 * empty — the pane that belongs in it is in the air. Without this the gap reads as
				 * nothing at all rather than as a destination, and the drag has no target: you can
				 * see that the layout changed but not that it changed *for you*.
				 *
				 * Not while landing. By then the pane is on its way into the space and outlining it
				 * as well would be saying the same thing twice, in two places, for a fifth of a second.
				 */}
				{carried &&
					!carried.landing &&
					(() => {
						const target = boxes.find((box) => box.kind === carried.kind);
						if (!target) return null;
						return (
							<div
								aria-hidden
								data-dock-drop
								className="ly-dock-drop pointer-events-none absolute"
								style={{
									left: pct(target.left),
									top: pct(target.top),
									width: pct(target.width),
									height: pct(target.height),
								}}
							/>
						);
					})()}

				{order.current.map((kind) => {
					const laid = boxes.find((box) => box.kind === kind);
					// Not in the tree and not in the air either: it was closed, and is gone.
					if (!laid && carried?.kind !== kind) return null;
					const { label, icon } = describe(kind);
					// Collapsed and maximised are the same geometry — the whole dock — which is why
					// neither needs a second component or a second code path. A carried pane's box is
					// ignored entirely; it is positioned against the window, not against the dock.
					const box = compact || maximized === kind ? WHOLE : (laid ?? WHOLE);
					return (
						<DockPane
							key={kind}
							kind={kind}
							box={box}
							label={label}
							icon={icon}
							maximized={maximized === kind}
							carried={carried?.kind === kind ? carried.rect : null}
							landing={carried?.kind === kind && carried.landing}
							hidden={compact && kind !== focused}
							draggable={!compact}
							onDragStart={(event) => start(kind, event)}
							onMove={(side) => useDock.getState().moveTo(kind, { side, kind: null })}
							actions={kind === "conversation" ? actions : undefined}
							inset={corner === kind ? TRAFFIC_LIGHTS : 0}
							onToggleMaximized={() => useDock.getState().toggleMaximized(kind)}
							onClose={kind === "conversation" ? undefined : () => useDock.getState().close(kind)}
							onFocus={() => useDock.getState().focus(kind)}
							onLanded={landed}
						>
							{kind === "conversation" ? renderConversation() : renderPanel(kind)}
						</DockPane>
					);
				})}
			</div>
		</div>
	);
}
