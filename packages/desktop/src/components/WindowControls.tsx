/**
 * The three buttons beside the traffic lights: sidebar, back, forward.
 *
 * Their own component because they have two homes. Normally they sit in the window's toolbar,
 * over whatever is at the top-left. But a full-screen panel reaches that corner, and buttons
 * floating over a card they do not belong to read as a mistake — so in that one case the panel
 * puts them at the head of its own tab strip instead, where they sit in a row with the tabs and
 * the first tab needs no clearance at all.
 *
 * Whoever renders them owns the positioning and the `no-drag` region; this is only the buttons.
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
			<ToolbarButton label="后退" onClick={() => history.back()}>
				<Chevron direction="left" />
			</ToolbarButton>
			<ToolbarButton label="前进" onClick={() => history.forward()}>
				<Chevron direction="right" />
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
			className={`no-drag flex h-7 w-7 items-center justify-center rounded-md transition-all duration-150 active:scale-90 ${
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


function Chevron({ direction }: { direction: "left" | "right" }) {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.9"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={direction === "right" ? { transform: "scaleX(-1)" } : undefined}
		>
			<path d="M15 18l-6-6 6-6" />
		</svg>
	);
}
