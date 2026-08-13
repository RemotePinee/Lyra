import { createElement } from "react";

/**
 * The app's type scale, as a component.
 *
 * Sizes were previously written at the call site — `text-[12.5px]`, `text-[11.5px]`, `text-[13px]`
 * — which is how a codebase ends up with twelve sizes where it meant to have six, and with the
 * same kind of text set two different ways on two different screens. The names below are the six
 * that survived a count of what was actually in use; anything that wants a seventh should be
 * asking whether it is really a new kind of text.
 *
 * `tone` and `weight` are here for the same reason: a caption is faint and a heading is not, and
 * that pairing should be decided once rather than remembered.
 */
const SIZES = {
	/** Page titles — one per screen. */
	display: "text-[26px] leading-tight font-semibold tracking-tight",
	/** Section and card headings. */
	title: "text-[15px] leading-snug",
	/** Prose: messages, descriptions, anything read a sentence at a time. */
	body: "text-[13px] leading-relaxed",
	/** Controls, rows, table cells — the app's working size. */
	label: "text-[12.5px] leading-normal",
	/** Secondary detail sitting under a label. */
	detail: "text-[11.5px] leading-relaxed",
	/** Timestamps, counts, badges. */
	caption: "text-[11px] leading-normal",
} as const;

const TONES = {
	default: "text-ink",
	muted: "text-ink-muted",
	faint: "text-ink-faint",
	danger: "text-danger",
	accent: "text-accent",
} as const;

const WEIGHTS = {
	normal: "",
	medium: "font-medium",
	semibold: "font-semibold",
} as const;

export function Text({
	size = "label",
	tone = "default",
	weight = "normal",
	as = "span",
	mono = false,
	numeric = false,
	className = "",
	children,
	...rest
}: {
	size?: keyof typeof SIZES;
	tone?: keyof typeof TONES;
	weight?: keyof typeof WEIGHTS;
	/** The element to render. `span` by default so it can sit inside a sentence. */
	as?: "span" | "p" | "div" | "h1" | "h2" | "h3" | "label" | "code";
	/** The code face, for identifiers and paths quoted inside prose. */
	mono?: boolean;
	/**
	 * Fixed-width digits.
	 *
	 * For numbers that change in place — token counts, timers, diff stats. Proportional digits
	 * make the text shuffle sideways on every tick, which reads as flicker.
	 */
	numeric?: boolean;
	className?: string;
	children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
	return createElement(
		as,
		{
			...rest,
			className: [
				SIZES[size],
				TONES[tone],
				WEIGHTS[weight],
				mono ? "font-mono" : "",
				numeric ? "tabular-nums" : "",
				className,
			]
				.filter(Boolean)
				.join(" "),
		},
		children,
	);
}
