/**
 * A plugin's mark.
 *
 * Uses the logo from the manifest when there is one. When there is not — which is most loose
 * skills and every MCP server — it draws a lettered tile instead of falling back to one grey
 * generic icon repeated down the list. A list where every row looks identical is a list you
 * have to read word by word; a stable colour per name means you start recognising entries by
 * their tile before you have read anything.
 *
 * The colour is derived from the name rather than stored, so it survives a rename of the
 * display label and needs nothing written to disk. Hues are spaced around the wheel and kept
 * at one saturation and lightness, so no entry shouts louder than its neighbours and the whole
 * column still reads as one set.
 */
export function PluginIcon({
	name,
	logo,
	brandColor,
	size = 32,
}: {
	name: string;
	/** Absolute path or data URL from the manifest, if the plugin ships one. */
	logo?: string;
	/** Manifest-declared colour, which wins over the derived one. */
	brandColor?: string;
	size?: number;
}) {
	const radius = Math.round(size * 0.28);

	if (logo) {
		return (
			<img
				src={logo}
				alt=""
				width={size}
				height={size}
				style={{ borderRadius: radius }}
				className="shrink-0 object-cover"
			/>
		);
	}

	const hue = brandColor ? null : hueFor(name);
	const background = brandColor
		? `linear-gradient(145deg, ${brandColor}, color-mix(in srgb, ${brandColor} 72%, #000))`
		: `linear-gradient(145deg, hsl(${hue} 62% 58%), hsl(${(hue! + 26) % 360} 60% 48%))`;

	return (
		<span
			aria-hidden
			style={{ width: size, height: size, borderRadius: radius, background, fontSize: Math.round(size * 0.42) }}
			className="flex shrink-0 items-center justify-center font-semibold text-white select-none"
		>
			{initial(name)}
		</span>
	);
}

/** First letter for latin names, first character otherwise — CJK has no useful "initial". */
function initial(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "?";
	const letter = /[a-z]/i.exec(trimmed);
	return (letter ? letter[0] : trimmed[0]).toUpperCase();
}

/**
 * A stable hue from a name.
 *
 * FNV-1a rather than a sum of char codes: the sum collides on anagrams, which is exactly what
 * near-identical plugin names tend to be (`fs-tools` and `tools-fs`).
 */
function hueFor(name: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		hash ^= name.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return Math.abs(hash) % 360;
}
