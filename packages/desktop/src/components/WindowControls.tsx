/**
 * The button beside the traffic lights: show or hide the sidebar.
 *
 * Its own component because it has two homes. Normally it sits in the window's toolbar, over
 * whatever is at the top-left. But a full-screen panel reaches that corner, and a button
 * floating over a card it does not belong to reads as a mistake — so in that one case the panel
 * puts it at the head of its own tab strip instead, where it sits in a row with the tabs.
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
	onClick: () => void;
	active?: boolean;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={active}
			onClick={onClick}
			className={`no-drag flex h-7 w-7 items-center justify-center rounded-md transition-all duration-150 ${
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
				className="transition-opacity duration-200"
				opacity={open ? 0.5 : 0}
			/>
		</svg>
	);
}
