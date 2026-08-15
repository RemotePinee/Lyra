/**
 * What the window shows between opening and the settings arriving.
 *
 * Almost always a few hundred milliseconds, which is the whole design problem: anything that
 * announces itself immediately is a flash, and a flash is what makes a fast launch feel broken.
 * So nothing is drawn for the first half-second, and what does appear afterwards is one arc and
 * the app's name, fading in over a full second rather than snapping on.
 *
 * The colours come from the preload, which paints the saved theme before the first frame — without
 * it this screen was always dark, and a light-theme app began every launch by flashing.
 */

import { useEffect, useState } from "react";
import { Spinner } from "./RunningIndicator.tsx";

/** Long enough that a normal launch never shows anything at all. */
const QUIET_MS = 500;

export function BootScreen() {
	const [shown, setShown] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => setShown(true), QUIET_MS);
		return () => clearTimeout(timer);
	}, []);

	return (
		<div className="flex h-full items-center justify-center bg-shell" aria-busy>
			<div
				className="flex flex-col items-center gap-3.5 transition-opacity duration-[900ms] ease-out"
				style={{ opacity: shown ? 1 : 0 }}
			>
				<Spinner size={20} />
				<span className="text-[12px] tracking-[0.14em] text-ink-faint/80 uppercase">Lyra</span>
			</div>
		</div>
	);
}
