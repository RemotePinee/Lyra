/**
 * The same surface as the main composer, at panel scale.
 *
 * Not the main `Composer` component itself: that one sends to the active session, carries the
 * project and branch chips, and takes image attachments. None of that applies here — this
 * conversation has no project of its own and cannot act on one.
 */

import type { UserContent } from "@deepwise/core";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { useApp } from "../../store.ts";
import { ComposerSend, ComposerShell } from "../ComposerShell.tsx";

export function SideComposer({
	running,
	disabled,
	onSend,
	onStop,
	onReset,
}: {
	running: boolean;
	/** No session to be beside; the field stays visible but inert rather than vanishing. */
	disabled?: boolean;
	onSend: (content: UserContent[]) => void;
	onStop: () => void;
	onReset?: () => void;
}) {
	const settings = useApp((s) => s.settings);
	const meta = useApp((s) => s.meta);
	const [text, setText] = useState("");

	function submit() {
		const trimmed = text.trim();
		if (!trimmed || running || disabled) return;
		setText("");
		onSend([{ type: "text", text: trimmed }]);
	}

	// Stated, not offered. The side chat runs on whatever the main session runs on.
	const modelName = findModelName(settings, meta?.modelId ?? settings?.defaultModelId ?? null);

	/*
	 * 15, because of what sits below it: the panel's 4px inset plus its 1px card border. The
	 * main composer rests 20px off the window's bottom edge, and 15 + 1 + 4 lands on the same
	 * line — which is what stops the two fields looking a pixel out of step side by side.
	 */
	return (
		// Same cap as the transcript above it, so the field stays under the messages it answers.
		<div className="mx-auto w-full max-w-[var(--dw-content)] shrink-0 px-3 pt-2 pb-[15px]">
			<ComposerShell
				value={text}
				onChange={setText}
				onSubmit={submit}
				disabled={disabled}
				placeholder={disabled ? "还没有可以聊的会话" : "问点关于这个会话的事"}
				left={
					<span
						data-dw-tip={modelName ? `跟随主会话：${modelName}` : undefined}
						className="h-7 min-w-0 truncate px-2 text-[12.5px] leading-7 text-ink-faint"
					>
						{modelName ?? "未配置模型"}
					</span>
				}
				right={
					<>
						{onReset && !running && (
							<button
								type="button"
								data-dw-tip="新的侧边聊天"
								aria-label="新的侧边聊天"
								onClick={onReset}
								className="mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-card-hover hover:text-ink"
							>
								<RotateCcw size={13.5} strokeWidth={1.9} />
							</button>
						)}
						<ComposerSend running={running} disabled={!text.trim() || disabled} onSend={submit} onStop={onStop} />
					</>
				}
			/>
		</div>
	);
}

function findModelName(
	settings: ReturnType<typeof useApp.getState>["settings"],
	modelId: string | null,
): string | null {
	if (!settings || !modelId) return null;
	for (const provider of settings.providers) {
		const model = provider.models.find((m) => m.id === modelId);
		if (model) return model.name;
	}
	return null;
}
