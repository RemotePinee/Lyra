/**
 * Asking before something cannot be taken back.
 *
 * The app deleted plenty of things on a single click — a plugin's directory, a model, an MCP
 * server, a whole session — and every one of them was a click's distance from a control you were
 * aiming at anyway. What existed instead was one hand-built overlay in the permission picker, for
 * the one case somebody happened to worry about.
 *
 * Anchored to the control that would do the deed, not centred over the window. A modal is a claim
 * that everything else must wait, which is true of "grant full access to your machine" and is not
 * true of "remove this server from a list". The connection between the button and the question is
 * also the answer to "wait, which one did I click".
 *
 * Two ways in, one look:
 *
 *   - `useConfirmer()` for a button that deletes — wrap the handler, render `element` once;
 *   - `ConfirmBody` for a menu that turns into the question rather than opening a second surface
 *     on top of the first.
 *
 * Only for what cannot be undone. Archiving, disabling and unpinning all put themselves back, and
 * a confirmation on those teaches people to click through the ones that matter.
 */

import { useState } from "react";

import { Popover } from "./Popover.tsx";

export interface ConfirmOptions {
	/** The question, naming the thing. "卸载 Chrome？" — not "确定吗？". */
	title: string;
	/** What it costs, in one line. Skip it when the title already says everything. */
	detail?: React.ReactNode;
	/** The verb, on the button that does it. */
	confirmLabel: string;
	onConfirm: () => void;
}

/**
 * The question and the two ways out.
 *
 * Cancel holds the focus, deliberately: this surface exists because something irreversible was one
 * click away, and putting the keyboard on the irreversible half of it would hand back the problem.
 */
export function ConfirmBody({
	title,
	detail,
	confirmLabel,
	onConfirm,
	onCancel,
}: ConfirmOptions & { onCancel: () => void }) {
	return (
		<div className="p-3">
			<div className="text-label font-medium text-ink">{title}</div>
			{detail && <p className="mt-1.5 text-detail leading-relaxed text-ink-muted">{detail}</p>}
			<div className="mt-3 flex items-center justify-end gap-1.5">
				<button
					type="button"
					autoFocus
					onClick={onCancel}
					className="h-[28px] rounded-lg border border-line px-2.5 text-detail text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink"
				>
					取消
				</button>
				<button
					type="button"
					onClick={onConfirm}
					className="h-[28px] rounded-lg bg-danger px-2.5 text-detail font-medium text-shell transition-opacity duration-[var(--ly-t-quick)] hover:opacity-90"
				>
					{confirmLabel}
				</button>
			</div>
		</div>
	);
}

/** The question on its own surface, hung off the control that raised it. */
export function Confirm({
	anchor,
	onClose,
	...options
}: ConfirmOptions & { anchor: HTMLElement; onClose: () => void }) {
	return (
		<Popover
			anchor={anchor}
			onClose={onClose}
			placement="bottom"
			align="end"
			width="panel"
			role="dialog"
			label={options.title}
		>
			<ConfirmBody
				{...options}
				onCancel={onClose}
				onConfirm={() => {
					onClose();
					options.onConfirm();
				}}
			/>
		</Popover>
	);
}

/**
 * One confirmation for a page full of delete buttons.
 *
 * Each button hands over its own question and its own consequence; the surface, the wording of
 * the two buttons and the fact that cancel is the safe one are settled here. A page with six
 * removable rows would otherwise carry six copies of the same state.
 */
export function useConfirmer() {
	const [pending, setPending] = useState<{ anchor: HTMLElement; options: ConfirmOptions } | null>(null);

	return {
		/** Call from the click handler of the button that would delete. */
		ask: (event: React.MouseEvent<HTMLElement>, options: ConfirmOptions) =>
			setPending({ anchor: event.currentTarget, options }),
		/** Render once, anywhere in the component. */
		element: pending ? (
			<Confirm anchor={pending.anchor} onClose={() => setPending(null)} {...pending.options} />
		) : null,
	};
}
