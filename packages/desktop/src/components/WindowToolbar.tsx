/**
 * The window's top edge: what drags it, and the buttons that float over everything.
 *
 * All three parts are here because their order in the DOM is the whole point. Electron builds the
 * draggable region by walking the document in order, so a `drag` element after a `no-drag` one
 * fills the hole back in — which is why these are rendered last in the shell, and why the band and
 * the buttons are separate elements rather than one.
 */

import { Maximize2, Minimize2 } from "lucide-react";
import { RightPanelIcon } from "./RightPanelIcon.tsx";
import { ToolbarButton, WindowControls } from "./WindowControls.tsx";

/**
 * Left offset of the first toolbar button, when there are traffic lights to clear.
 *
 * The three lights are 12pt wide on a 20pt pitch starting at x=16, so they end at 68.5. Starting
 * at 78 leaves the ~10pt gap the reference screenshots have; 70 put the button flush against the
 * green light.
 */
const TOOLBAR_LEFT = 78;

/**
 * And where it goes when there are none.
 *
 * macOS takes the lights away in native full screen. Holding their inset open then leaves a gap at
 * the top-left reserved for three buttons that are not there — which is exactly what it looks
 * like. 12 is the same margin the rest of the window's edges use.
 */
const TOOLBAR_LEFT_FULLSCREEN = 12;

/**
 * The draggable band.
 *
 * Deliberately below the panel: a full-width band above it would intercept every click meant for
 * the panel's own title bar — which is exactly what it did to the sidebar toggle in compact, where
 * the panel covers the window.
 */
export function DragBand() {
	return <div className="drag-region absolute inset-x-0 top-0 z-40 h-[44px]" />;
}

/**
 * The panel controls, above the panel rather than behind it.
 *
 * Separate from the band, and only as wide as they are. The panel sits at z-50 and, now that it
 * stays mounted, occupies the right of the window whenever it is open — which put these
 * underneath it, invisible and unclickable. Floating them over it is also what keeps them still:
 * the panel's title bar has the room for them, so they land in the same place whether it is open
 * or not.
 */
export function PanelControls({
	compact,
	navOpen,
	panelOpen,
	expanded,
	onToggleExpanded,
	onTogglePanel,
}: {
	compact: boolean;
	navOpen: boolean;
	panelOpen: boolean;
	expanded: boolean;
	onToggleExpanded: () => void;
	onTogglePanel: () => void;
}) {
	return (
		<div className="pointer-events-none absolute inset-x-0 top-0 z-[60] h-[44px]">
			<div className="no-drag toolbar-right pointer-events-auto absolute top-0 flex h-[44px] items-center gap-0.5">
				{/*
				 * One control, in one place, for both directions.
				 *
				 * This used to disappear when the panel opened, on the grounds that the panel's own
				 * title bar carries a close button in roughly this spot. Roughly is the problem: the
				 * panel insets itself by six pixels and draws a border, so the button landed a few
				 * pixels off from where it had just been and the eye caught every open and close as
				 * a jump. Now it only hands over when the panel genuinely covers this corner.
				 */}
				{!(compact && navOpen) && (
					<>
						{/*
						 * Only means something with a panel to expand. Placed to the left of the
						 * toggle so that appearing and disappearing never shifts the button beside it.
						 */}
						{panelOpen && !compact && (
							<ToolbarButton label={expanded ? "退出全屏（Esc）" : "全屏显示"} onClick={onToggleExpanded}>
								{expanded ? <Minimize2 size={12.5} strokeWidth={1.9} /> : <Maximize2 size={12.5} strokeWidth={1.9} />}
							</ToolbarButton>
						)}
						<ToolbarButton label={panelOpen ? "收起面板" : "展开面板"} onClick={onTogglePanel}>
							<RightPanelIcon active={panelOpen} />
						</ToolbarButton>
					</>
				)}
			</div>
		</div>
	);
}

/**
 * The window's own controls, while something of the window is still visible behind them.
 *
 * When the panel reaches the left edge it hosts these itself, inside its tab strip. Floating them
 * over its card instead left three buttons sitting in a surface they had nothing to do with, and
 * pushed the first tab 172px inward to get out of their way.
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
