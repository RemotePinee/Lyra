/**
 * The list that appears when a message starts with a slash.
 *
 * Above the field, because the field sits at the bottom of the window and a list under it would
 * open off-screen or shove the conversation upward as it grew.
 *
 * Names only, with one line at the foot describing whichever is highlighted. The first attempt put
 * the description and the source on every row, and a row with three things on it stops being
 * scannable — the eye has to parse each line instead of running down a column of names, which is
 * the whole reason a list like this is faster than remembering.
 *
 * A footer rather than a tooltip, though a tooltip is what this app usually reaches for: the
 * description is wanted *while choosing*, and a tip that needs a hover and a pause is not available
 * to somebody moving through the list on the arrow keys. It also sits in one fixed place, so the
 * eye is not chasing a bubble around as the highlight moves.
 *
 * Presentational. Which commands, which one is current and what picking one does belong to the
 * composer, since they are the same state as the text being typed.
 */

import { useEffect, useRef } from "react";

/**
 * One row.
 *
 * Flattened rather than carrying a `SlashCommand`, because two different things end up in the same
 * list — commands read off disk and the handful built into the app — and the list has no reason to
 * know which is which.
 */
export interface CommandEntry {
	name: string;
	description: string;
	argumentHint?: string;
	/** 内置 / 项目 / 个人 / Claude — carried for the tooltip, not drawn on the row. */
	origin: string;
}

/**
 * The matched run, in the app's ink; everything else a step back.
 *
 * Inverted from the obvious way round — the match is emphasised rather than the remainder dimmed —
 * so that a list filtered to one letter does not turn into a wall of grey with one dark speck.
 */
function Highlighted({ text, term }: { text: string; term: string }) {
	const at = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;
	if (at < 0) return <span className="text-ink">{text}</span>;
	return (
		<>
			<span className="text-ink-muted">{text.slice(0, at)}</span>
			<span className="font-semibold text-ink">{text.slice(at, at + term.length)}</span>
			<span className="text-ink-muted">{text.slice(at + term.length)}</span>
		</>
	);
}

export function CommandMenu({
	commands,
	term,
	active,
	onPick,
	onHover,
}: {
	commands: CommandEntry[];
	/** What has been typed after the slash, for highlighting. */
	term: string;
	active: number;
	onPick: (command: CommandEntry) => void;
	onHover: (index: number) => void;
}) {
	const list = useRef<HTMLDivElement>(null);

	/*
	 * Keep the current row in view when the arrows move it.
	 *
	 * `block: "nearest"` so walking down a long list scrolls by one row rather than recentring on
	 * every keystroke, which reads as the list jumping under you.
	 */
	useEffect(() => {
		const row = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [active]);

	if (commands.length === 0) return null;
	const current = commands[Math.min(active, commands.length - 1)];

	return (
		/*
		 * `ly-glass-solid`, not a blurred surface.
		 *
		 * This is pinned inside scrolling content, and `backdrop-filter` only samples what has been
		 * painted inside the nearest backdrop root — every masked scroller in this app makes one, so
		 * a frosted panel here would come out tinted and shadowed with nothing actually blurred and
		 * the composer's own controls showing through it.
		 */
		<div
			className="ly-glass-solid absolute bottom-full left-0 z-40 mb-2 min-w-[240px] max-w-[420px] overflow-hidden rounded-[12px] border border-line-soft"
			role="listbox"
			aria-label="斜杠命令"
		>
			<div ref={list} className="ly-scroll max-h-[min(320px,42vh)] overflow-y-auto p-1">
				{commands.map((command, index) => (
					<button
						key={`${command.origin}:${command.name}`}
						type="button"
						data-index={index}
						role="option"
						aria-selected={index === active}
						/*
						 * `onMouseDown` with the default prevented, not `onClick`.
						 *
						 * Clicking moves focus out of the textarea before the click lands, which closes
						 * the menu and loses the caret. Taking it on mousedown and refusing the focus
						 * change keeps the field focused throughout, so picking with the mouse leaves
						 * you where picking with Enter does.
						 */
						onMouseDown={(event) => {
							event.preventDefault();
							onPick(command);
						}}
						onMouseMove={() => onHover(index)}
						className={`flex w-full items-baseline gap-2 rounded-[7px] px-2.5 py-[5px] text-left font-mono text-label transition-colors duration-[var(--ly-t-quick)] ${
							index === active ? "bg-card-hover" : ""
						}`}
					>
						<span className="truncate">
							<Highlighted text={command.name} term={term} />
						</span>
						{command.argumentHint && (
							<span className="shrink-0 truncate text-detail text-ink-faint">{command.argumentHint}</span>
						)}
					</button>
				))}
			</div>

			{/*
			 * What the highlighted one does, in one line that never moves.
			 *
			 * Rendered even when the description is empty, so the panel does not change height as the
			 * highlight travels — a list that grew and shrank by a row under the arrow keys would be
			 * the most distracting thing on the screen.
			 */}
			<div className="border-t border-line-soft px-3 py-2" data-ly-command-detail>
				<p className="truncate text-detail text-ink-muted">
					{current?.description || " "}
					{current && (
						<span className="ml-2 text-ink-faint">{current.origin}</span>
					)}
				</p>
			</div>
		</div>
	);
}
