import type { UserContent } from "@lyra/core";
import { CircleAlert, Folder, GitBranch, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChangeBar } from "./ChangeBar.tsx";
import { ComposerSend, ComposerShell } from "./ComposerShell.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { EffortMenu, effortLabel } from "./EffortMenu.tsx";
import { ScrollText } from "./ScrollText.tsx";
import { ModelMenu } from "./ModelMenu.tsx";
import { usePopover } from "./Popover.tsx";
import { BranchMenu } from "./modals/BranchMenu.tsx";
import { PermissionPicker } from "./modals/PermissionPicker.tsx";
import { ProjectPicker } from "./modals/ProjectPicker.tsx";
import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";

const PERMISSION_LABEL: Record<string, string> = {
	ask: "请求批准",
	auto: "帮我批准",
	full: "完全访问",
};

interface Attachment {
	id: string;
	name: string;
	mimeType: string;
	data: string;
}

export function Composer() {
	const workspace = useApp((s) => s.workspace);
	const scratchCwd = useApp((s) => s.scratchCwd);
	const settings = useApp((s) => s.settings);
	const meta = useApp((s) => s.meta);
	const messages = useApp((s) => s.messages);
	const running = useApp((s) => s.running);
	const activeSessionId = useApp((s) => s.activeSessionId);
	// "底部面板" in Settings → 常规. Saved but read by nothing until now.
	const showBottomPanel = useApp((s) => s.settings?.editor.showBottomPanel) ?? true;
	const send = useApp((s) => s.send);
	const abort = useApp((s) => s.abort);
	const { compact } = useLayout();

	const [text, setText] = useState("");

	/*
	 * Text left here by something outside the composer — opening a review, so far.
	 *
	 * Taken and cleared, so it lands once and is then the user's to edit or discard. Appended
	 * rather than replacing anything already typed: whatever is in the field was typed by hand and
	 * losing it would be worse than an awkward join.
	 */
	const draft = useApp((s) => s.composerDraft);
	useEffect(() => {
		if (!draft) return;
		setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${draft}` : draft));
		useApp.getState().setComposerDraft("");
	}, [draft]);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const modelMenu = usePopover();
	const effortMenu = usePopover();
	const permissionMenu = usePopover();
	const projectMenu = usePopover();
	const branchMenu = usePopover();
	const fileRef = useRef<HTMLInputElement>(null);

	const modelId = meta?.modelId ?? settings?.defaultModelId ?? null;
	const modelName = findModelName(settings, modelId);
	const permissionMode = settings?.permissionMode ?? "auto";
	/**
	 * Settled by the first message.
	 *
	 * The transcript holds provider-specific handles — response ids, thinking signatures,
	 * encrypted reasoning — that another model cannot replay. Once there is history to carry
	 * forward, this stops being a control and becomes a label saying what this conversation
	 * runs on.
	 */
	const modelLocked = messages.length > 0;

	async function submit() {
		const trimmed = text.trim();
		if (!trimmed && attachments.length === 0) return;
		const content: UserContent[] = [
			...attachments.map((a): UserContent => ({ type: "image", data: a.data, mimeType: a.mimeType })),
			...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
		];
		setText("");
		setAttachments([]);
		await send(content);
	}

	async function addFiles(files: FileList | null) {
		if (!files) return;
		const next: Attachment[] = [];
		for (const file of Array.from(files).slice(0, 8)) {
			if (!file.type.startsWith("image/")) continue;
			const buffer = await file.arrayBuffer();
			next.push({
				id: `${file.name}-${Date.now()}-${Math.random()}`,
				name: file.name,
				mimeType: file.type,
				data: bytesToBase64(new Uint8Array(buffer)),
			});
		}
		if (next.length > 0) setAttachments((prev) => [...prev, ...next]);
	}

	return (
		<div className={`shrink-0 pt-2 pb-5 ${compact ? "px-4" : "px-8"}`}>
			<div className="mx-auto w-full max-w-[var(--ly-content)]">
				{/*
				 * Where the turn will run, and what it has already changed.
				 *
				 * The chips shrink and ellipsise rather than being dropped when space runs short,
				 * because "which project, which branch" is exactly what you need before send.
				 *
				 * One row, because these are the same question asked at two moments: the project
				 * and branch are what you check before pressing send, the change counts are what
				 * you check after. Splitting them into two strips would cost a row of height to
				 * separate things you read together.
				 */}
				{showBottomPanel && (
				<div className="flex items-center gap-0.5 overflow-hidden pb-1">
					<Chip
						icon={<Folder size={13} strokeWidth={1.8} />}
						/*
						 * 「无项目」 when that is a choice, 「选择项目」 when nothing has been chosen yet.
						 *
						 * Reviewing a repository that is not checked out here, or 「不在项目中工作」, both
						 * leave the workspace empty on purpose — and a chip that goes on saying
						 * 「选择项目」 reads as an unfinished step rather than as the state the user asked
						 * for. The picker is still behind it either way.
						 */
						label={workspace?.name ?? (scratchCwd ? "无项目" : "选择项目")}
						onClick={projectMenu.toggle}
						active={projectMenu.open}
					/>
					{workspace?.branch && (
						<Chip
							icon={<GitBranch size={13} strokeWidth={1.8} />}
							label={workspace.branch}
							onClick={branchMenu.toggle}
							active={branchMenu.open}
						/>
					)}
					<div className="min-w-2 flex-1" />
					<ChangeBar />
				</div>
				)}

				<ComposerShell
					value={text}
					onChange={setText}
					onSubmit={() => void submit()}
					placeholder="随心输入"
					onFiles={(files) => void addFiles(files)}
					attachments={
						attachments.length > 0 ? (
							<div className="flex flex-wrap gap-2 px-4 pt-3.5">
								{attachments.map((attachment) => (
									<div key={attachment.id} className="relative">
										<img
											src={`data:${attachment.mimeType};base64,${attachment.data}`}
											alt={attachment.name}
											className="h-[68px] w-[92px] rounded-lg border border-line object-cover"
										/>
										<button
											type="button"
											onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
											className="absolute -top-1.5 -right-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-line bg-float text-ink-muted transition-colors hover:text-ink"
										>
											<X size={11} strokeWidth={2.2} />
										</button>
									</div>
								))}
							</div>
						) : undefined
					}
					left={
						<>
							<button
								type="button"
								data-ly-tip="添加图片"
								aria-label="添加图片"
								onClick={() => fileRef.current?.click()}
								className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
							>
								<Plus size={16} strokeWidth={1.9} />
							</button>
							<input
								ref={fileRef}
								type="file"
								accept="image/*"
								multiple
								hidden
								onChange={(e) => {
									void addFiles(e.target.files);
									e.target.value = "";
								}}
							/>

							<button
								type="button"
								/* The app's own tooltip, so the icon-only form still says what it is. */
								data-ly-tip={PERMISSION_LABEL[permissionMode]}
								data-ly-tip-side="top"
								aria-label={PERMISSION_LABEL[permissionMode]}
								onClick={permissionMenu.toggle}
								aria-haspopup="menu"
								aria-expanded={permissionMenu.open}
								className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-label transition-colors duration-150 ${
									permissionMode === "full"
										? // Red, not the accent: this is the one mode that hands over the machine.
											`text-danger ${permissionMenu.open ? "bg-danger/10" : "hover:bg-danger/10"}`
										: permissionMenu.open
											? "bg-card-hover text-ink"
											: "text-ink-muted hover:bg-card-hover hover:text-ink"
								}`}
							>
								<CircleAlert size={13.5} strokeWidth={1.9} className="shrink-0" />
								{/*
								 * The label is the first thing to go when space runs out.
								 *
								 * Full access used to keep its words at every width, on the grounds
								 * that it must never be quietly on. But a label that refuses to
								 * yield just pushes the rest of the row out; the mark carries that
								 * meaning on its own now that it is red, and the tooltip says the
								 * word for anyone unsure.
								 *
								 * Measured against the field rather than the window: with a sidebar
								 * and a panel open, a roomy-looking window still leaves this row
								 * about 350px, and the label has to go long before the layout is
								 * "compact".
								 */}
								<span className="@max-[420px]:hidden">{PERMISSION_LABEL[permissionMode]}</span>
							</button>
						</>
					}
					right={
						<>
							{/* Beside the model it is measured against — the window is a property of that model. */}
							<ContextMeter messages={messages} settings={settings} modelId={modelId} sessionId={activeSessionId} />

							{modelLocked ? (
								// A label, not a disabled button: nothing here is going to become
								// clickable, so it should not look like something that might.
								<span
									data-ly-tip={`${modelName ?? "模型"} · 对话开始后不能更换，新建对话可选`}
									className="h-7 min-w-0 truncate px-2 text-label leading-7 text-ink-faint"
								>
									{modelName ?? "未配置模型"}
								</span>
							) : (
								<button
									type="button"
									onClick={modelMenu.toggle}
									data-ly-tip={modelName ?? "选择模型"}
									aria-haspopup="menu"
									aria-expanded={modelMenu.open}
									className={`h-7 min-w-0 truncate rounded-md px-2 text-label transition-colors ${
										modelMenu.open ? "bg-card-hover text-ink" : "text-ink-muted hover:bg-card-hover hover:text-ink"
									}`}
								>
									{modelName ?? "选择模型"}
								</button>
							)}
							<button
								type="button"
								onClick={effortMenu.toggle}
								aria-haspopup="menu"
								aria-expanded={effortMenu.open}
								data-ly-tip={`推理强度：${effortLabel(settings?.thinking ?? "medium")}`}
								className={`mr-1.5 h-7 shrink-0 rounded-md px-2 text-label transition-colors ${
									effortMenu.open ? "bg-card-hover text-ink" : "text-ink-faint hover:bg-card-hover hover:text-ink"
								}`}
							>
								{effortLabel(settings?.thinking ?? "medium")}
							</button>

							<ComposerSend
								running={running}
								disabled={!text.trim() && attachments.length === 0}
								onSend={() => void submit()}
								onStop={() => void abort()}
							/>
						</>
					}
				/>
			</div>

			{permissionMenu.open && <PermissionPicker anchor={permissionMenu.anchor} onClose={permissionMenu.close} />}
			{projectMenu.open && <ProjectPicker anchor={projectMenu.anchor} onClose={projectMenu.close} />}
			{branchMenu.open && <BranchMenu anchor={branchMenu.anchor} onClose={branchMenu.close} />}
			{modelMenu.open && <ModelMenu anchor={modelMenu.anchor} onClose={modelMenu.close} />}
			{effortMenu.open && <EffortMenu anchor={effortMenu.anchor} onClose={effortMenu.close} />}
		</div>
	);
}

function Chip({
	icon,
	label,
	onClick,
	active,
}: {
	icon: React.ReactNode;
	label: string;
	onClick: (event: React.MouseEvent<HTMLElement>) => void;
	active?: boolean;
}) {
	return (
		<button
			type="button"
			data-ly-tip={label}
			aria-haspopup="menu"
			aria-expanded={active}
			onClick={onClick}
			className={`ly-scroll flex h-[26px] min-w-0 items-center gap-1.5 rounded-md px-2 text-label transition-colors duration-150 ${
				active ? "bg-card-hover text-ink" : "text-ink-muted hover:bg-card-hover hover:text-ink"
			}`}
		>
			<span className="shrink-0 text-ink-faint">{icon}</span>
			<ScrollText text={label} className="min-w-0" />
		</button>
	);
}

function findModelName(settings: ReturnType<typeof useApp.getState>["settings"], modelId: string | null): string | null {
	if (!settings || !modelId) return null;
	for (const provider of settings.providers) {
		const model = provider.models.find((m) => m.id === modelId);
		if (model) return model.name;
	}
	return null;
}

/** btoa cannot take a raw byte array; chunk it so large images do not blow the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
