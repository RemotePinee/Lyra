/**
 * A GitHub account, as a face.
 *
 * A name alone makes a timeline read as a log. Faces are what let you find the one human comment
 * among nine from a bot without reading any of them — recognition rather than reading, which is
 * the whole reason avatars exist on every code host.
 *
 * The image comes from the main process as a data URL. The renderer's Content-Security-Policy
 * allows no remote images on purpose, and widening it for a 20pt circle would widen it for every
 * rendered comment body as well.
 *
 * The initial is the resting state, not the error state: it is drawn immediately, the picture
 * replaces it if one arrives, and nothing about the layout moves either way. A bot with no avatar,
 * a machine with no network and a first paint all look the same, which is what stops this from
 * flickering through a placeholder on every render.
 */

import { useEffect, useState } from "react";

export function Avatar({ login, size = 18 }: { login: string; size?: number }) {
	const [src, setSrc] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setSrc(null);
		if (!login) return;
		void window.lyra.git
			.avatar(login)
			.then((url) => {
				if (!cancelled) setSrc(url);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [login]);

	return (
		<span
			aria-hidden
			style={{ width: size, height: size }}
			className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-card text-caption text-ink-faint select-none"
		>
			{src ? (
				<img src={src} alt="" width={size} height={size} className="h-full w-full object-cover" draggable={false} />
			) : (
				(login[0] ?? "?").toUpperCase()
			)}
		</span>
	);
}
