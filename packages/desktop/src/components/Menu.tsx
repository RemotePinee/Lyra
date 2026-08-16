/**
 * The pieces a menu is made of: a row, a separator, a heading, a scrolling body.
 *
 * Separate from `Popover`, which is only a positioned surface. A popover can hold anything — a
 * colour picker, a form — and a menu can live somewhere that is not a popover. Keeping the two
 * apart is what stops "how a row looks" and "where the surface lands" from being edited together
 * by accident.
 */

import { ScrollText } from "./ScrollText.tsx";

/**
 * One row in a menu.
 *
 * Every menu in the app had grown its own version of this — different heights, different
 * corner radii, one with no radius at all — so the same gesture looked different depending on
 * which menu you were in. The visual states live in `.ly-item` so a row that needs a
 * different shape (the permission picker's two-line entries) can still opt into them.
 */
export function MenuItem({
	icon,
	children,
	detail,
	hint,
	trailing,
	selected,
	danger,
	disabled,
	title,
	onClick,
}: {
	icon?: React.ReactNode;
	children: React.ReactNode;
	/**
	 * A second line explaining the choice.
	 *
	 * Handled here rather than by each menu laying out its own two-line row: the permission
	 * picker used to do exactly that and ended up with its own height, padding and hover
	 * treatment, so the same gesture looked different depending which menu you were in.
	 */
	detail?: React.ReactNode;
	/** Right-aligned annotation: a count, a shortcut digit, a context size. */
	hint?: React.ReactNode;
	/** Right-aligned element, for a checkmark or a chevron. */
	trailing?: React.ReactNode;
	selected?: boolean;
	danger?: boolean;
	disabled?: boolean;
	title?: string;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			data-ly-tip={title}
			data-selected={selected ? "true" : undefined}
			data-danger={danger ? "true" : undefined}
			onClick={onClick}
			className={`ly-scroll ly-item flex w-full gap-2.5 px-2 text-left text-label ${
				detail ? "items-start py-1.5" : "h-[28px] items-center"
			}`}
		>
			{icon && <span className={`shrink-0 text-ink-muted ${detail ? "mt-[3px]" : ""}`}>{icon}</span>}
			<span className="min-w-0 flex-1">
				{typeof children === "string" ? <ScrollText text={children} /> : children}
				{/* One line. A detail that wraps makes its row taller than its neighbours, and a menu
				 * of ragged rows is harder to scan than one where the odd path is cut short. */}
				{detail && (
					<span className="mt-0.5 block truncate text-caption leading-snug opacity-65">{detail}</span>
				)}
			</span>
			{hint !== undefined && (
				<span className={`shrink-0 font-mono text-caption text-ink-faint ${detail ? "mt-[3px]" : ""}`}>{hint}</span>
			)}
			{trailing}
		</button>
	);
}

/** Separates groups of items inside a menu. */
export function MenuSeparator() {
	return <div className="my-1 h-px bg-line-soft" />;
}

/** Small label above a group of items. */
export function MenuLabel({ children }: { children: React.ReactNode }) {
	return <div className="px-2 pt-1.5 pb-1 text-caption text-ink-faint">{children}</div>;
}

/**
 * The padded box every menu's contents sit in.
 *
 * Rows are rounded, so the panel needs a margin for them to sit inside — and every menu
 * needing the same margin is exactly the sort of thing that drifts if each one writes it out.
 */
export function MenuBody({ children }: { children: React.ReactNode }) {
	return <div className="p-1">{children}</div>;
}
