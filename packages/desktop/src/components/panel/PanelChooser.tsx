/**
 * The panel's first screen: pick what to put in it.
 *
 * Not an empty state and not a fallback — this is where the panel starts, and it stays until a
 * choice is made. Opening straight onto a guessed tab means guessing wrong often enough that the
 * first thing you do is close something you never asked for.
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
		<div className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 px-2 pb-6">
			{definitions.map((def) => (
				<button
					key={def.kind}
					type="button"
					disabled={Boolean(def.unavailable)}
					data-dw-tip={def.unavailable}
					onClick={() => onPick(def.kind)}
					className="dw-item flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px]"
				>
					<def.icon size={16} strokeWidth={1.6} className="shrink-0 text-ink-muted" />
					<span className="min-w-0 flex-1 truncate">{def.label}</span>
					<span className="shrink-0 text-[11.5px] text-ink-faint">{def.shortcut}</span>
				</button>
			))}

			{definitions.some((d) => d.unavailable) && (
				<p className="px-3 pt-3 text-[11.5px] leading-relaxed text-ink-faint">
					{definitions.find((d) => d.unavailable)?.unavailable}后可用。
				</p>
			)}
		</div>
	);
}
