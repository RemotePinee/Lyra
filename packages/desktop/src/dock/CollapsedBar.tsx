/**
 * The narrow-window form: one pane at a time, and a row to pick which.
 *
 * The tree is not thrown away when the window gets small — it is simply not drawn. Every pane is
 * laid over the whole dock and all but one is hidden, so widening the window brings the layout
 * back exactly as it was rather than as whatever a collapse-and-rebuild happened to produce.
 *
 * A row of chips rather than the old tab strip. There is nothing to close here and nothing to add:
 * this is a *view* of a layout that was arranged at a comfortable width, and offering to edit it
 * through a 380pt window is offering a fight nobody wins.
 */

import type { PaneKind } from "./tree.ts";

export interface CollapsedItem {
	kind: PaneKind;
	label: string;
	icon?: React.ReactNode;
}

export function CollapsedBar({
	items,
	focused,
	onFocus,
}: {
	items: CollapsedItem[];
	focused: PaneKind;
	onFocus: (kind: PaneKind) => void;
}) {
	// One pane is not a choice, and a row offering it is a row of noise.
	if (items.length < 2) return null;

	return (
		<div
			role="tablist"
			aria-label="面板"
			// Scrolls rather than wraps: at this width five panes do not fit, and a second row
			// would take height from the one pane the whole layout exists to show.
			className="ly-dock-bar flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1.5"
		>
			{items.map((item) => {
				const active = item.kind === focused;
				return (
					<button
						key={item.kind}
						type="button"
						role="tab"
						aria-selected={active}
						data-dock-chip={item.kind}
						onClick={() => onFocus(item.kind)}
						className={`flex h-[24px] shrink-0 items-center gap-1.5 rounded-md px-2 text-detail transition-colors duration-[var(--ly-t-quick)] ${
							active ? "bg-card-hover text-ink" : "text-ink-muted hover:bg-card-hover/50"
						}`}
					>
						{item.icon && <span className="flex shrink-0 items-center text-ink-faint">{item.icon}</span>}
						<span className="truncate">{item.label}</span>
					</button>
				);
			})}
		</div>
	);
}
