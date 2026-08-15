/**
 * Saying something about a pull request, and deciding about it.
 *
 * One field for both, because they are the same sentence with a different weight behind it: a
 * comment is a remark, an approval is a remark that also unblocks a merge. Splitting them into two
 * boxes would mean writing the thought, then deciding which box it belonged in.
 *
 * "请求修改" refuses to send without a reason. A change request with no explanation is the one
 * outcome that reliably wastes someone's afternoon.
 */

import { ArrowUp, Check, X } from "lucide-react";
import { useState } from "react";

export type Verdict = "approve" | "request-changes" | "comment";

export function ReviewBar({
	onSubmit,
	disabled,
}: {
	onSubmit: (verdict: Verdict, body: string) => Promise<string | null>;
	disabled?: boolean;
}) {
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const send = async (verdict: Verdict) => {
		if (busy || disabled) return;
		setBusy(true);
		setError(null);
		const failure = await onSubmit(verdict, body);
		setBusy(false);
		if (failure) {
			setError(failure);
			return;
		}
		// Only cleared on success: a failed send must not take the text with it.
		setBody("");
	};

	return (
		<div className="shrink-0 border-t border-line-soft px-4 py-3">
			{error && <p className="pb-2 text-[12px] leading-relaxed text-danger">{error}</p>}

			<div className="ly-composer rounded-[11px] border border-line px-3 py-2">
				<textarea
					value={body}
					onChange={(event) => setBody(event.target.value)}
					onKeyDown={(event) => {
						// ⌘↵ sends a plain comment; the two decisions are deliberate clicks.
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							void send("comment");
						}
					}}
					rows={2}
					disabled={disabled}
					placeholder={disabled ? "选中一个 Pull Request" : "留下评论…"}
					className="max-h-[160px] min-h-[38px] w-full resize-none bg-transparent text-[12.5px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
				/>

				<div className="flex items-center gap-1.5 pt-1">
					<button
						type="button"
						disabled={busy || disabled}
						onClick={() => void send("approve")}
						data-ly-tip="批准这个 Pull Request"
						className="flex h-[26px] items-center gap-1 rounded-lg border border-line px-2.5 text-[12px] text-ink-muted transition-colors hover:border-ok/50 hover:text-ok disabled:opacity-45"
					>
						<Check size={12.5} strokeWidth={2} />
						批准
					</button>
					<button
						type="button"
						disabled={busy || disabled}
						onClick={() => void send("request-changes")}
						data-ly-tip="请求修改，需要写明理由"
						className="flex h-[26px] items-center gap-1 rounded-lg border border-line px-2.5 text-[12px] text-ink-muted transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-45"
					>
						<X size={12.5} strokeWidth={2} />
						请求修改
					</button>

					<div className="flex-1" />

					<button
						type="button"
						disabled={busy || disabled || !body.trim()}
						onClick={() => void send("comment")}
						data-ly-tip="发表评论 ⌘↵"
						aria-label="发表评论"
						className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-elevated text-ink transition-colors hover:bg-card-hover disabled:opacity-40"
					>
						<ArrowUp size={13} strokeWidth={2.2} />
					</button>
				</div>
			</div>
		</div>
	);
}
