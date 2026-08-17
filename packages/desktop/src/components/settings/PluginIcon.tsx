/**
 * A bundle's mark.
 *
 * Its own icon when it shipped one, and one shared default when it did not.
 *
 * Two things stood here before. First the initial letter — a wall of lettered tiles is a wall of
 * squares you have to read, and `A` tells you nothing about AgentFlow that the word beside it did
 * not. Then a glyph guessed from the name on a colour hashed from the same name, which is better
 * to look at and worse to trust: it is *generated identity*, a plausible-looking mark that was
 * never chosen by anyone, and telling nine of them apart trains the eye on shapes that mean
 * nothing.
 *
 * A bundle either brought an icon or it did not. The ones that did are the ones worth
 * distinguishing at a glance; for the rest, saying "no icon" once, in one picture, is the honest
 * answer — and it is a prompt to give the entry a real one in the registry.
 */
import { useEffect, useState } from "react";

import fallback from "../../assets/plugin-fallback.png?inline";

/**
 * A remote logo, resolved to something the page is allowed to draw.
 *
 * `img-src` is `self data: blob:` and stays that way — see `registry:icon`. So a logo that is an
 * https URL cannot be put in a `src` directly: it renders as a broken image, which is worse than no
 * image at all because it looks like the app failed rather than like the entry has no icon. The main
 * process fetches it and hands back a data URL.
 *
 * Local sources — a data URL from a manifest, or a bundled asset — are used as they are.
 */
function useResolved(logo: string | undefined): string | null {
	const remote = logo?.startsWith("https://") ? logo : null;
	const [resolved, setResolved] = useState<string | null>(null);

	useEffect(() => {
		if (!remote) return setResolved(null);
		let alive = true;
		void window.lyra.plugins
			.icon(remote)
			.then((data) => alive && setResolved(data))
			.catch(() => alive && setResolved(null));
		return () => {
			alive = false;
		};
	}, [remote]);

	return remote ? resolved : (logo ?? null);
}


/**
 * A bundle's icon, or the one every bundle without an icon shares.
 *
 * `name`, `id`, `category` and `brandColor` are still accepted and ignored: they fed the generated
 * mark this replaced, and every call site passes them. Removing them from the signature would be a
 * change to nine files that says nothing, and keeping them costs a line.
 */
export function PluginIcon({
	logo,
	size = 32,
}: {
	name?: string;
	logo?: string;
	brandColor?: string;
	category?: string;
	id?: string;
	size?: number;
}) {
	const radius = Math.round(size * 0.28);
	const src = useResolved(logo);

	if (src) {
		return (
			<img
				src={src}
				alt=""
				width={size}
				height={size}
				style={{ borderRadius: radius }}
				className="shrink-0 object-cover"
			/>
		);
	}

	/*
	 * A real picture, not a generated one.
	 *
	 * What stood here drew a lucide glyph on a colour derived from the name — clever, and wrong in
	 * the way generated identity always is: it tells you the bundle has no icon, dressed up as
	 * though it had one. Nine entries each got a different plausible-looking mark that meant
	 * nothing, and telling them apart trained you to read shapes that were never chosen.
	 *
	 * One honest default instead. A bundle either shipped an icon or it did not, and the ones that
	 * did are the ones worth distinguishing at a glance.
	 */
	return (
		<img
			src={fallback}
			alt=""
			width={size}
			height={size}
			style={{ borderRadius: radius }}
			className="shrink-0 object-cover"
		/>
	);
}
