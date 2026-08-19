/**
 * Where the first window control sits, measured from the window's left edge.
 *
 * The three traffic lights are 12pt wide on a 20pt pitch starting at x=16, so they end at 68.5;
 * 78 leaves the ~10pt gap the reference screenshots have, and 70 put the button flush against the
 * green one.
 *
 * It used to be shared with the side panel's tab strip, which took this row over whenever the
 * panel reached the window's left edge — and the two answered the same question with 78 and 88,
 * ten pixels being small enough to look like a rendering wobble and large enough to see. The dock
 * ended that handover: the sidebar or the toolbar owns this corner, always.
 */
export const WINDOW_CONTROLS_LEFT = 78;

/** A toolbar button, and the gap after it. Shared so what sits beside one can clear it. */
export const TOOLBAR_BUTTON = 28;
export const TOOLBAR_GAP = 10;

/**
 * How much of the window's top-left corner belongs to the window rather than to the content.
 *
 * The traffic lights *and* the sidebar toggle: with the sidebar closed, that toggle is the only
 * way back to it, and it floats over whatever the dock has put in that corner. A pane that only
 * cleared the lights drew its own title straight underneath the button — the terminal's first tab
 * ended up on top of it, so the tab was hard to read and the button, still there and still
 * working, looked like it had gone.
 *
 * Here rather than in `WindowToolbar`, which the dock would otherwise have to import — and that
 * file reaches into the dock's own store, so the two would depend on each other.
 */
export const TOOLBAR_RESERVED = WINDOW_CONTROLS_LEFT + TOOLBAR_BUTTON + TOOLBAR_GAP;

/**
 * The button beside the traffic lights: show or hide the sidebar.
 *
 * Back and forward used to live here too. There is nothing to go back to: this is one window
 * with panes, not a stack of pages, so both were permanently inert.
 *
 * Whoever renders it owns the positioning and the `no-drag` region; this is only the button.
 */
export function WindowControls({
	navOpen,
	onToggleNav,
	active,
}: {
	navOpen: boolean;
	onToggleNav: () => void;
	/** Filled in, for the compact layout where the sidebar is a drawer that is currently over you. */
	active?: boolean;
}) {
	return (
		<>
			<ToolbarButton label={navOpen ? "隐藏侧边栏 ⌘B" : "显示侧边栏 ⌘B"} onClick={onToggleNav} active={active}>
				<SidebarIcon open={navOpen} />
			</ToolbarButton>
		</>
	);
}

export function ToolbarButton({
	children,
	label,
	onClick,
	active,
}: {
	children: React.ReactNode;
	label: string;
	/**
	 * The event is passed on for the callers that anchor a popover to this button.
	 *
	 * Optional to receive: a handler written `() => …` ignores it, which is what every other
	 * caller does.
	 */
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	active?: boolean;
}) {
	return (
		<button
			type="button"
			data-ly-tip={label}
			aria-label={label}
			aria-pressed={active}
			onClick={onClick}
			className={`no-drag flex h-7 w-7 items-center justify-center rounded-md transition-all duration-[var(--ly-t-quick)] ${
				active ? "bg-card-hover text-ink" : "text-ink-faint hover:bg-card-hover hover:text-ink"
			}`}
		>
			{children}
		</button>
	);
}

/** The sidebar pane fills in while it is open, so the icon reflects state without moving. */
function SidebarIcon({ open }: { open: boolean }) {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<line x1="9.5" y1="4" x2="9.5" y2="20" />
			<rect
				x="3"
				y="4"
				width="6.5"
				height="16"
				rx="2.5"
				fill="currentColor"
				stroke="none"
				className="transition-opacity duration-[var(--ly-t-base)]"
				opacity={open ? 0.5 : 0}
			/>
		</svg>
	);
}
