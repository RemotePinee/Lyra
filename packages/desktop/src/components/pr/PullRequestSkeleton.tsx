/**
 * The shape of what is coming, while it comes.
 *
 * These replace three "正在读取…" labels. A line of text centred in an empty pane says only that
 * the app is not broken; it gives no sense of how much is on the way, it lands in a different
 * place from the content that replaces it, and the swap moves the whole pane. Blocks in the
 * layout the real rows will occupy answer "how long, roughly" and then get out of the way
 * without anything jumping.
 *
 * `ly-defer-in` on each, because most of these loads are fast now that the list is cached: a
 * placeholder that appears and vanishes inside one blink reads as a flicker, so it stays fully
 * transparent for the first 170ms and never appears at all when the answer beats it.
 */

/** Rows in the list pane, at the two-line height a pull request row actually is. */
export function ListSkeleton() {
	// Uneven, so it reads as a list of titles rather than as a progress bar.
	const rows = [82, 64, 91, 55, 76, 68];

	return (
		<div className="ly-defer-in ly-pulse flex flex-col gap-1 px-1 pt-1" aria-busy>
			{rows.map((width, index) => (
				<div key={index} className="flex gap-2.5 rounded-[9px] px-2 py-2">
					<div className="mt-[3px] h-[13px] w-[13px] shrink-0 rounded bg-card" />
					<div className="min-w-0 flex-1">
						<div className="h-[13px] rounded bg-card" style={{ width: `${width}%` }} />
						<div className="mt-[7px] h-[11px] w-[42%] rounded bg-card" />
					</div>
				</div>
			))}
		</div>
	);
}

/** The detail pane: a title, the field rows under it, then the description. */
export function DetailSkeleton() {
	return (
		<div className="ly-defer-in ly-pulse flex min-h-0 flex-1 flex-col px-5 pt-1" aria-busy>
			<div className="h-[22px] w-[62%] rounded bg-card" />
			<div className="mt-2.5 h-[12px] w-[38%] rounded bg-card" />

			{/* The five metadata rows — branch, reviewers, comments, checks, state. */}
			<div className="flex flex-col gap-2.5 pt-6">
				{[46, 30, 24, 34, 28].map((width, index) => (
					<div key={index} className="flex items-center gap-4">
						<div className="h-[12px] w-[52px] shrink-0 rounded bg-card" />
						<div className="h-[12px] rounded bg-card" style={{ width: `${width}%` }} />
					</div>
				))}
			</div>

			<div className="flex flex-col gap-2 pt-8">
				{[88, 71, 94, 58].map((width, index) => (
					<div key={index} className="h-[12px] rounded bg-card" style={{ width: `${width}%` }} />
				))}
			</div>
		</div>
	);
}

/** The diff pane: a file header, then a block of lines under it, twice. */
export function CodeSkeleton() {
	return (
		<div className="ly-defer-in ly-pulse flex min-h-0 flex-1 flex-col gap-3 px-2 pt-1" aria-busy>
			{[0, 1].map((file) => (
				<div key={file} className="flex flex-col gap-2">
					<div className="flex items-center gap-2 px-1">
						<div className="h-[13px] w-[13px] shrink-0 rounded bg-card" />
						<div className="h-[13px] w-[46%] rounded bg-card" />
					</div>
					<div className="flex flex-col gap-[5px] pl-6">
						{[74, 52, 86, 63, 45].map((width, index) => (
							<div key={index} className="h-[11px] rounded bg-card" style={{ width: `${width}%` }} />
						))}
					</div>
				</div>
			))}
		</div>
	);
}
