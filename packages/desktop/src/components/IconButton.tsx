import { Tooltip } from "./Tooltip.tsx";

/**
 * A button whose label is an icon.
 *
 * Every toolbar in the app had grown its own: five heights, three corner radii, and press
 * feedback that ranged from nothing to a 10% shrink. The shrink is gone on purpose — a control
 * that jumps away from the pointer at the moment of contact reads as unstable, and at these
 * sizes it is a wobble rather than a press. Pressing is shown by the fill going one step
 * darker, which is what a real button does: it stays exactly where it is and changes state.
 *
 * The label is both the tooltip and the accessible name, so a caller cannot ship one without
 * the other — which is how icon-only toolbars end up unreadable to screen readers.
 */
export function IconButton({
	label,
	icon,
	onClick,
	active,
	disabled,
	tone = "default",
	size = "md",
	tipSide = "bottom",
	className = "",
}: {
	label: string;
	icon: React.ReactNode;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	/** Held down / currently on, for toggles like "match case". */
	active?: boolean;
	disabled?: boolean;
	tone?: "default" | "danger";
	size?: "sm" | "md";
	tipSide?: "top" | "bottom";
	className?: string;
}) {
	const button = (
		<button
			type="button"
			aria-label={label}
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
			className={`flex shrink-0 items-center justify-center rounded-md transition-colors duration-[var(--ly-t-quick)] disabled:opacity-40 ${
				size === "sm" ? "h-[22px] w-[22px]" : "h-[26px] w-[26px]"
			} ${
				tone === "danger"
					? "text-ink-faint hover:bg-danger/10 hover:text-danger active:bg-danger/15"
					: active
						? "bg-card-hover text-ink active:bg-elevated"
						: "text-ink-faint hover:bg-card-hover hover:text-ink active:bg-elevated"
			} ${className}`}
		>
			{icon}
		</button>
	);

	// A disabled control explains nothing by hovering, and its tip would never dismiss on click.
	return disabled ? button : <Tooltip label={label} side={tipSide}>{button}</Tooltip>;
}
