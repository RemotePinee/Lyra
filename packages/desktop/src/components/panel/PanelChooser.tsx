/**
 * The panel's first screen: pick what to put in it.
 *
 * Not an empty state and not a fallback — this is where the panel starts, and it stays until a
 * choice is made. Opening straight onto a guessed tab means guessing wrong often enough that the
 * first thing you do is close something you never asked for.
 *
 * It says so, and it starts at the top. Centred in the pane with nothing above it, a list of seven
 * items reads as a panel whose contents failed to arrive rather than as a menu — the layout has to
 * make the difference, because the items themselves look the same either way.
 */

import type { PanelKind } from "../../sideStore.ts";
import type { ResolvedPanel } from "./definitions.tsx";

export function PanelChooser({
	definitions,
	onPick,
}: {
	definitions: ResolvedPanel[];
	onPick: (kind: PanelKind) => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-0.5 px-2 pt-2 pb-6">
			<p className="px-3 pt-1 pb-2 text-detail text-ink-faint">在这里打开：</p>
			{definitions.map((def) => (
				<button
					key={def.kind}
					type="button"
					disabled={Boolean(def.unavailable)}
					data-ly-tip={def.unavailable}
					onClick={() => onPick(def.kind)}
					className="ly-item flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-label"
				>
					<def.icon size={16} strokeWidth={1.6} className="shrink-0 text-ink-muted" />
					<span className="min-w-0 flex-1 truncate">{def.label}</span>
					<span className="shrink-0 text-detail text-ink-faint">{def.shortcut}</span>
				</button>
			))}

			{/* Which of them are greyed, and why. Only when something actually is. */}
			{definitions.some((d) => d.unavailable) && (
				<p className="px-3 pt-3 text-detail leading-relaxed text-ink-faint">
					变灰的几项{definitions.find((d) => d.unavailable)?.unavailable}后可用。
				</p>
			)}
		</div>
	);
}
