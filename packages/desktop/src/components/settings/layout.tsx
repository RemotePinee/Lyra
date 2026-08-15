/**
 * How a settings page is laid out: a heading, a card, a labelled row.
 *
 * Two shapes for the same thing, and the difference is the point. `Row` puts the label and the
 * control on one line, which works while the control is small; `Field` stacks them, which is what
 * a full-width input needs. Both are here, side by side, where the choice between them is visible.
 */

import { Text } from "../Text.tsx";

/** Section heading above a card group, as used by the reference settings pages. */
export function SectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<Text as="h2" size="title" weight="medium" className="mb-3">
			{children}
		</Text>
	);
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
	return <div className={`overflow-hidden rounded-[12px] border border-line bg-card/40 ${className}`}>{children}</div>;
}

/** One labelled row inside a card, with the control right-aligned. */
export function Row({
	title,
	detail,
	control,
	children,
}: {
	title: string;
	detail?: React.ReactNode;
	control?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		/*
		 * The control drops below the text when the row runs out of width.
		 *
		 * A control is `shrink-0` — a segmented picker squeezed to nothing is worse than one
		 * that moved — so beside it the description took whatever was left. In a narrow window
		 * that was a column two or three characters wide and a dozen lines tall, which reads as
		 * broken rather than as compact. Measured against the row, so a wide window is unchanged.
		 */
		<div className="@container border-b border-line-soft px-4 py-3.5 last:border-b-0">
			<div className="flex flex-col gap-2 @md:flex-row @md:items-start @md:gap-4">
				<div className="min-w-0 flex-1">
					<Text as="div" size="body">
						{title}
					</Text>
					{detail && (
						<Text as="div" size="label" tone="muted" className="mt-0.5 leading-relaxed">
							{detail}
						</Text>
					)}
				</div>
				{control && <div className="shrink-0 @md:pt-0.5">{control}</div>}
			</div>
			{children}
		</div>
	);
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<label className="block">
			<Text size="label" tone="muted" className="mb-1.5 block">
				{label}
			</Text>
			{children}
			{hint && (
				<Text size="detail" tone="faint" className="mt-1.5 block">
					{hint}
				</Text>
			)}
		</label>
	);
}
