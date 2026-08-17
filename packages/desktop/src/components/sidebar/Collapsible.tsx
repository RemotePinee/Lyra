/**
 * A section that folds shut, with the fold actually animating.
 *
 * `max-height` is the usual way and it is a guess: too small clips a long list, too large makes
 * the transition finish early and the last part of the fold happen with nothing moving. A grid
 * whose single row goes from `1fr` to `0fr` interpolates against the content's real height, so a
 * project with three sessions and one with thirty both take the same time and neither is cut off.
 *
 * `overflow: hidden` on the inner element rather than the grid: the grid track is what shrinks,
 * and the child has to be willing to be smaller than its content for that to be visible.
 *
 * Collapsed content stays mounted but is taken out of the tab order — a fold is a visual state,
 * and a list nobody can see is a list nobody should be able to tab into.
 */

export function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
	return (
		<div
			className="grid transition-[grid-template-rows] duration-[var(--ly-t-base)] ease-out"
			style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
		>
			<div className="overflow-hidden" inert={!open}>
				{children}
			</div>
		</div>
	);
}
