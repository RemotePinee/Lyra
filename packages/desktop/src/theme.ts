/**
 * Runtime theming.
 *
 * Tailwind's `@theme` block emits the design tokens as CSS variables on `:root`. Overriding
 * those same variables at runtime is what makes the appearance page actually do something —
 * every surface in the app already reads from them.
 *
 * Only three colours are configurable (accent, background, foreground). The rest of the scale
 * is derived, so a user picking a background cannot end up with unreadable text or invisible
 * borders: surfaces step away from the background and text steps toward the foreground, both
 * scaled by the contrast slider.
 */

import type { AppearanceSettings } from "@lyra/core";

interface Rgb {
	r: number;
	g: number;
	b: number;
}

export function applyAppearance(appearance: AppearanceSettings): void {
	const root = document.documentElement;
	const dark = resolveDark(appearance.theme);

	const background = parseHex(dark ? appearance.darkBackground : appearance.lightBackground) ?? {
		r: 23,
		g: 23,
		b: 23,
	};
	const foreground = parseHex(dark ? appearance.darkForeground : appearance.lightForeground) ?? {
		r: 237,
		g: 237,
		b: 237,
	};
	const accent = appearance.accent;

	// 0–100 maps to a 0.5×–1.5× multiplier on every derived step.
	const strength = 0.5 + appearance.contrast / 100;

	/*
	 * Surfaces and rules are scaled apart, and only on a light theme.
	 *
	 * Both used to come off the same curve, which produced a scale where the rule (#ececed) was
	 * *paler* than the card it was meant to divide (#f0f0f0) — a border lighter than its own
	 * surface separates nothing, so every layer had to earn its separation by getting greyer
	 * instead. Stacked three deep that is where "the whole app looks grey" comes from.
	 *
	 * So on light: surfaces stay close to the page and the rules step well clear of it, which is
	 * how the apps this is measured against read as clean — white panels, visible hairlines.
	 * Dark themes already work the other way round: a surface lifts off the page by getting
	 * lighter, which is the same direction its text goes, and there the shared curve is correct.
	 */
	const SURFACE_ON_LIGHT = 0.45;
	const RULE_ON_LIGHT = 1.7;

	const surface = (step: number) =>
		toHex(mix(background, foreground, Math.min(0.9, step * strength * (dark ? 1 : SURFACE_ON_LIGHT))));
	const rule = (step: number) =>
		toHex(mix(background, foreground, Math.min(0.9, step * strength * (dark ? 1 : RULE_ON_LIGHT))));
	const text = (weight: number) => toHex(mix(background, foreground, Math.min(1, weight)));
	/** A wash of the foreground at a given opacity — reads against any backdrop, including none. */
	const veil = (alpha: number) => `color-mix(in srgb, ${toHex(foreground)} ${(alpha * 100).toFixed(1)}%, transparent)`;

	/**
	 * Fields read as paper: lighter than the page, never darker.
	 *
	 * Every other surface steps from the background toward the foreground, which is correct for
	 * cards and panels. Applied to an input on a light theme it goes the wrong way — the
	 * composer came out grey against a white page, when the thing you type into should be the
	 * brightest surface on screen. Dark themes step toward the foreground as usual; light ones
	 * step toward white, so a tinted background still yields a field that sits above it.
	 */
	const paper = dark ? surface(0.035) : toHex(mix(background, { r: 255, g: 255, b: 255 }, 0.65));

	/**
	 * Menus and popovers: the surface that floats above everything else.
	 *
	 * Same problem as `paper`, one step further. A menu derived by stepping toward the
	 * foreground came out darker than the page it floats over, and blurring a dark translucent
	 * panel over a light page just produces grey. Floating things are lighter than what they
	 * cover, in either theme.
	 */
	const float_ = dark ? surface(0.1) : toHex(mix(background, { r: 255, g: 255, b: 255 }, 0.8));

	const tokens: Record<string, string> = {
		"--color-shell": toHex(background),
		/*
		 * Separated by area, not by a line.
		 *
		 * This used to sit 1.6% off the page while the divider beside it sat 11% off — so the
		 * eye had nothing to read but the rule, and a 1px stripe at seven times the contrast of
		 * the surfaces it divides is all anyone saw. Widening the tint and dropping the border
		 * swaps a high-frequency edge for a low-frequency field, which is how a sidebar reads as
		 * a different region rather than as the same page with a line drawn on it.
		 */
		"--color-sidebar": surface(0.042),
		"--color-panel": surface(0.04),
		"--color-card": surface(0.06),
		/*
		 * The two interaction states are a veil, not a colour.
		 *
		 * Every other surface is an opaque mix of background and foreground, which is right for
		 * a card that sits on a known page. Hover is different: it lands on the translucent
		 * sidebar as often as on a card, and there the background is whatever the desktop behind
		 * the window happens to be. An opaque #f5f6f6 over a white desktop is invisible — which
		 * is exactly what happened to the session list. A translucent wash of the foreground
		 * darkens whatever it covers by the same amount, so the state reads on every surface.
		 */
		"--color-card-hover": veil(dark ? 0.062 : 0.05),
		"--color-input": paper,
		"--color-elevated": veil(dark ? 0.1 : 0.085),
		"--color-float": float_,
		/* The rules carry the separation on light, so they have to be visible against it. */
		"--color-line": rule(0.075),
		"--color-line-soft": rule(0.05),
		"--color-ink": toHex(foreground),
		"--color-ink-muted": text(0.62),
		"--color-ink-faint": text(0.4),
		/*
		 * Both, because "强调色" in Settings means this one colour.
		 *
		 * Only `--color-info` was ever written here, so `--color-accent` kept the hard-coded
		 * orange from the stylesheet — every `text-accent` in the app was a colour nobody chose,
		 * and changing the setting did nothing to it.
		 */
		"--color-accent": accent,
		"--color-info": accent,
		"--ly-ui-font": appearance.uiFont,
		"--ly-code-font": appearance.codeFont,
		"--ly-ui-size": `${appearance.uiFontSize}px`,
		"--ly-code-size": `${appearance.codeFontSize}px`,
	};

	for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);

	/*
	 * The window itself has to know the theme, for two separate reasons.
	 *
	 * Windows and Linux draw their own controls into the title strip, which would otherwise
	 * stay dark over a light theme. And on every platform the window paints a backing colour
	 * that shows through whenever a resize outruns the renderer's reflow — dragging an edge
	 * quickly is exactly that, and a stale colour there is the black frame that flashes.
	 */
	window.lyra?.setWindowTheme?.({ color: toHex(background), symbolColor: text(0.62) });

	root.classList.toggle("dark", dark);
	root.classList.toggle("light", !dark);
	/*
	 * Declared, not just implied by the class.
	 *
	 * The editor's syntax colours are written with `light-dark()`, which resolves against this
	 * property and nothing else — without it every token would take the light branch on a dark
	 * theme. It also gets form controls and scrollbars right for free.
	 */
	root.style.colorScheme = dark ? "dark" : "light";
	root.dataset.diffMarkers = appearance.diffMarkers;
	root.dataset.pointerCursor = String(appearance.pointerCursor);
	root.dataset.fontSmoothing = String(appearance.fontSmoothing);
	root.dataset.reduceMotion = appearance.reduceMotion;
}

/** Re-apply on system scheme changes while the theme is set to follow the system. */
export function watchSystemTheme(getAppearance: () => AppearanceSettings): () => void {
	const query = window.matchMedia("(prefers-color-scheme: dark)");
	const onChange = () => {
		if (getAppearance().theme === "system") applyAppearance(getAppearance());
	};
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

function resolveDark(theme: AppearanceSettings["theme"]): boolean {
	if (theme === "dark") return true;
	if (theme === "light") return false;
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function parseHex(hex: string): Rgb | null {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return null;
	let value = match[1];
	if (value.length === 3) value = value.split("").map((c) => c + c).join("");
	return {
		r: Number.parseInt(value.slice(0, 2), 16),
		g: Number.parseInt(value.slice(2, 4), 16),
		b: Number.parseInt(value.slice(4, 6), 16),
	};
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
	const t = Math.max(0, Math.min(1, amount));
	return {
		r: Math.round(from.r + (to.r - from.r) * t),
		g: Math.round(from.g + (to.g - from.g) * t),
		b: Math.round(from.b + (to.b - from.b) * t),
	};
}

function toHex({ r, g, b }: Rgb): string {
	return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Whether motion is currently switched off, for the animations CSS cannot express.
 *
 * The stylesheet handles its own under `:root[data-reduce-motion]`, but a rewrite that steps
 * through intermediate strings is state, not style — there is no duration to shorten, only frames
 * to not run. Read at the moment it matters rather than subscribed to: these are one-shot
 * animations, and one that has already started can finish.
 */
export function motionReduced(): boolean {
	const setting = document.documentElement.dataset.reduceMotion;
	if (setting === "on") return true;
	if (setting === "off") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Readable text colour for a swatch, so a hex chip stays legible on any background. */
export function contrastingInk(hex: string): string {
	const rgb = parseHex(hex);
	if (!rgb) return "#ffffff";
	// Relative luminance, sRGB coefficients.
	const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
	return luminance > 0.6 ? "#1a1c1f" : "#ffffff";
}
