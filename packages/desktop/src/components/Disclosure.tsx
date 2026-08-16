/**
 * A section that folds away, and the one place the app decides what that looks like.
 *
 * There were three spellings of this before it existed: a `▾` character that swapped to `▸`, a
 * chevron that appeared and disappeared, and a block that was simply rendered or not. All three
 * read as different mechanisms rather than as one idea, and the character version was the worst of
 * them — a glyph is drawn at whatever weight the font feels like and cannot rotate, so opening was
 * a substitution rather than a movement.
 *
 * What this settles:
 *
 *   - the chevron rotates rather than being replaced, so the state is one object in two positions;
 *   - the body unfolds to its own height (`ly-reveal`), so closing is the same gesture as opening
 *     rather than a cut;
 *   - the header is a real button covering the whole row, so the hit target is the row and not the
 *     eleven pixels of the arrow;
 *   - a count sits next to the title rather than inside it, because "活动 3" is a heading and a
 *     quantity, not a five-character heading.
 */

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export function Disclosure({
	title,
	count,
	open,
	onToggle,
	trailing,
	children,
}: {
	title: string;
	/** Shown after the title. Zero is worth saying; undefined is not. */
	count?: number;
	open: boolean;
	onToggle: () => void;
	/** Controls that belong to the section rather than to its contents — an edit button, a link. */
	trailing?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="border-t border-line-soft first:border-t-0">
			<div className="flex items-center gap-1">
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					className="ly-item flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-2.5 pr-1.5 pl-1 text-left"
				>
					{/*
					 * One chevron, turned. Right when closed, down when open — the same rotation a
					 * disclosure triangle has made since before any of this, and the reason it reads
					 * without a label.
					 */}
					<ChevronRight
						size={13}
						strokeWidth={2.2}
						className="shrink-0 text-ink-faint transition-transform duration-[var(--ly-t-base)] ease-[var(--ly-e-out)]"
						style={{ transform: open ? "rotate(90deg)" : undefined }}
					/>
					<span className="text-label font-medium text-ink">{title}</span>
					{count !== undefined && <span className="text-detail text-ink-faint tabular-nums">{count}</span>}
				</button>

				{trailing}
			</div>

			<div className="ly-reveal" data-open={open} aria-hidden={!open}>
				<div>
					<div className="pb-3">{children}</div>
				</div>
			</div>
		</section>
	);
}
