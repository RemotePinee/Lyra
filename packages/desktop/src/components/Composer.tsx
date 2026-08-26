import type { UserContent } from "@lyra/core";
// Through the browser-safe door: the main barrel reaches the filesystem, and this runs in a page.
import { expandCommand, parseInvocation, rankCommands, type SlashCommand } from "@lyra/core/commands-view";
import { CircleAlert, Folder, GitBranch, MessageSquare, Plus, X } from "lucide-react";
import { openFromEvent } from "./image/viewer-store.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChangeBar } from "./ChangeBar.tsx";
import { CommandMenu } from "./CommandMenu.tsx";
import { ComposerSend, ComposerShell } from "./ComposerShell.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { EffortMenu, effortLabel } from "./EffortMenu.tsx";
import { ModelIcon } from "./ModelIcon.tsx";
import { RollingText, useRolled } from "./RollingText.tsx";
import { ScrollText } from "./ScrollText.tsx";
import { ModelMenu } from "./ModelMenu.tsx";
import { usePopover } from "./Popover.tsx";
import { BranchMenu } from "./modals/BranchMenu.tsx";
import { PermissionPicker } from "./modals/PermissionPicker.tsx";
import { ProjectPicker } from "./modals/ProjectPicker.tsx";
import { useLayout } from "../layout.tsx";
import { findModel } from "../models.ts";
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
	const switchingBranch = useApp((s) => s.switchingBranch);
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
	const field = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (!draft.text) return;
		setText((current) =>
			draft.replace || !current.trim() ? draft.text : `${current.trimEnd()}\n\n${draft.text}`,
		);
		useApp.getState().setComposerDraft("");
		/*
		 * And put the caret in it.
		 *
		 * What arrives this way is a starting point rather than a finished message — a suggestion
		 * card, a review to describe — so the next thing anybody does is edit it. Landing the text
		 * without the focus makes that a click they have to find first. At the end, not selected:
		 * this is a draft to add to, not one to type over.
		 */
		const el = field.current;
		if (el) {
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		}
	}, [draft]);
	const [attachments, setAttachments] = useState<Attachment[]>([]);

	/*
	 * Slash commands.
	 *
	 * `dismissed` is what Escape sets: the list closes but the text stays, because someone who
	 * typed `/` meaning a path should not have to delete it to be left alone. Any further edit
	 * clears it, so the list comes back the moment the text changes again — a menu that stayed
	 * shut until the field was emptied would be its own annoyance.
	 */
	const [commands, setCommands] = useState<SlashCommand[]>([]);
	const [active, setActive] = useState(0);
	const [dismissed, setDismissed] = useState(false);

	/**
	 * What is being typed after a slash, or `null` when nothing is.
	 *
	 * The slash has to start a word — beginning of the text, or straight after whitespace — and
	 * what follows it has to run to the end of what has been typed. That is what separates a
	 * command being chosen from the slashes that fill ordinary prose:
	 *
	 *   `/com`                 → offered
	 *   `啊手机壳就是的 /com`    → offered; a sentence can end in a command being reached for
	 *   `src/main.ts`          → not; the slash is inside a word
	 *   `2026/08/26`           → not, same reason
	 *   `/compact 参数`         → not; the name is settled and arguments are being typed
	 *
	 * An earlier version required the slash to be the very first character. That is the rule for
	 * *running* a command and it stays the rule below — but it made a poor rule for *offering* one,
	 * because the list simply never appeared for anyone who had already started typing.
	 */
	const term = useMemo(() => {
		const match = /(?:^|\s)\/([a-zA-Z0-9:_-]*)$/.exec(text);
		return match ? match[1] : null;
	}, [text]);

	/**
	 * The few commands that do something to the app rather than say something to the model.
	 *
	 * Kept deliberately short. Every name taken here is a name a user cannot have for their own
	 * command, so this is limited to the things that could not be written as a prompt at all: they
	 * act on the session itself.
	 */
	const builtins = useMemo(
		() => [
			{
				name: "compact",
				description: "把之前的对话压缩成摘要，腾出上下文",
				origin: "内置",
				run: async () => {
					if (!activeSessionId) return;
					const result = await window.lyra.sessions.compact(activeSessionId);
					if (result.ok) useApp.getState().notify("已把之前的对话压缩成摘要。");
					else if (result.reason) useApp.getState().notify(result.reason, "warn");
				},
			},
			{
				name: "clear",
				description: "开一个新对话",
				origin: "内置",
				run: async () => {
					await useApp.getState().newSession();
				},
			},
			{
				name: "commands",
				description: "管理斜杠命令，或新建一个",
				origin: "内置",
				run: () => {
					useApp.getState().setSettingsSection("commands");
					useApp.getState().setView("settings");
				},
			},
		],
		[activeSessionId],
	);

	/*
	 * Built-ins first, so a file command cannot quietly take one of their names.
	 *
	 * `rankCommands` sorts what survives, and the dedup before it is what makes the precedence
	 * real: a `compact.md` on disk is still listed by the settings page, it simply does not win
	 * the name here.
	 */
	const matches = useMemo(() => {
		if (term === null || dismissed) return [];
		const reserved = new Set(builtins.map((entry) => entry.name));
		const entries = [
			...builtins,
			...commands
				.filter((command) => !reserved.has(command.name))
				.map((command) => ({
					name: command.name,
					description: command.description,
					argumentHint: command.argumentHint,
					origin:
						command.origin === "claude"
							? command.scope === "workspace"
								? "Claude · 项目"
								: "Claude"
							: command.scope === "workspace"
								? "项目"
								: "个人",
					run: undefined,
				})),
		];
		return rankCommands(entries, term).slice(0, 50);
	}, [builtins, commands, term, dismissed]);

	/*
	 * Re-read the files whenever the list is about to be needed.
	 *
	 * These are markdown files people edit in another window, so a list cached at startup would be
	 * wrong more often than right. Keyed on "is there a slash at all" rather than on the term, so
	 * this is one read per time the menu opens rather than one per keystroke.
	 */
	const commandMode = term !== null;
	useEffect(() => {
		if (!commandMode) return;
		let alive = true;
		void window.lyra.commands.list(workspace?.path ?? "").then((result) => {
			if (alive) setCommands(result.commands);
		});
		return () => {
			alive = false;
		};
	}, [commandMode, workspace?.path]);

	// A different set of matches means the old highlight is meaningless.
	useEffect(() => {
		setActive(0);
	}, [term]);

	/**
	 * Put the chosen name in the field and leave the caret after it, ready for arguments.
	 *
	 * Chosen, not run — including for the built-ins, which have nothing to type after them. One
	 * more keystroke is worth it for a rule with no exceptions: picking from this list never does
	 * anything on its own, so nothing in it can fire from a stray Enter.
	 */
	function pick(command: { name: string }) {
		/*
		 * Replace the slash-word being typed, not the whole field.
		 *
		 * `term` only matches a slash that starts a word and runs to the end, so the last slash in
		 * the text is that word's start — anything before it is a sentence somebody wrote and must
		 * survive being offered a completion.
		 */
		const at = text.lastIndexOf("/");
		setText(`${at > 0 ? text.slice(0, at) : ""}/${command.name} `);
		setDismissed(false);
	}

	const modelMenu = usePopover();
	const effortMenu = usePopover();
	const permissionMenu = usePopover();
	const projectMenu = usePopover();
	const branchMenu = usePopover();
	const fileRef = useRef<HTMLInputElement>(null);

	/** No project behind this conversation, and that was the choice — not a step left undone. */
	const chatting = !workspace && Boolean(scratchCwd);
	const modelId = meta?.modelId ?? settings?.defaultModelId ?? null;
	// The whole record, not just its name: the mark beside it is chosen from the id the provider
	// knows the model by, which is not the same string as the label somebody typed for it.
	const model = findModel(settings, modelId);
	const modelName = model?.name ?? null;
	// The mark rolls with the name it belongs to, on the same terms — never on the first paint.
	const modelRolls = useRolled(modelId ?? "");
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

		/*
		 * A command becomes the prompt it stands for, here, before anything is sent.
		 *
		 * Expanded rather than sent as `/name` with the expansion hidden: what is in the transcript
		 * is then exactly what the model was given, which is the difference between a conversation
		 * you can audit and one where a step happened off-screen. It also costs nothing to explain
		 * afterwards — the instructions are right there.
		 *
		 * Re-read when the list is empty, for the paste-and-send case where the menu never opened.
		 * An unknown name is not an error: it goes out as typed, because `/` is also how people
		 * write paths and a composer that rejected them would be wrong far more often than right.
		 */
		let outgoing = trimmed;
		const invocation = parseInvocation(trimmed);

		/*
		 * A built-in acts on the session and sends nothing.
		 *
		 * Cleared first, because these are not instant — `/compact` is a model call — and a field
		 * that still held `/compact` while it ran would invite a second press.
		 */
		const builtin = invocation ? builtins.find((entry) => entry.name === invocation.name) : undefined;
		if (builtin) {
			setText("");
			setAttachments([]);
			await builtin.run();
			return;
		}

		if (invocation) {
			const known =
				commands.length > 0
					? commands
					: (await window.lyra.commands.list(workspace?.path ?? "").catch(() => ({ commands: [] }))).commands;
			const command = known.find((c) => c.name === invocation.name);
			if (command) outgoing = expandCommand(command, invocation.rest);
		}

		const content: UserContent[] = [
			...attachments.map((a): UserContent => ({ type: "image", data: a.data, mimeType: a.mimeType })),
			...(outgoing ? [{ type: "text" as const, text: outgoing }] : []),
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
						/*
						 * Chat, not 「无项目」.
						 *
						 * The old label named the state by what it lacks — a mode called "no project",
						 * which reads as something missing rather than as something chosen. What it
						 * actually is: a conversation with no checkout behind it. Reviewing a repository
						 * that is not on this machine, asking something that is not about code. That is a
						 * chat, and naming it after itself is the difference between a state and a gap.
						 *
						 * 「选择项目」 stays for the case where nothing has been chosen yet, which really is
						 * an unfinished step. The picker sits behind all three.
						 */
						icon={chatting ? <MessageSquare size={13} strokeWidth={1.8} /> : <Folder size={13} strokeWidth={1.8} />}
						label={workspace?.name ?? (chatting ? "Chat" : "选择项目")}
						onClick={projectMenu.toggle}
						active={projectMenu.open}
					/>
					{workspace?.branch && (
						/*
						 * The name stays put while a switch runs; the mark says it is running.
						 *
						 * Which is the whole point — see `BranchMenu`. Showing the target name early
						 * reads well right up until git refuses, and then the chip has claimed
						 * something that did not happen. A pulsing branch mark is honest about both
						 * outcomes and still answers the click immediately.
						 */
						<Chip
							icon={<GitBranch size={13} strokeWidth={1.8} className={switchingBranch ? "ly-pulse" : undefined} />}
							label={workspace.branch}
							busy={Boolean(switchingBranch)}
							onClick={branchMenu.toggle}
							active={branchMenu.open}
						/>
					)}
					<div className="min-w-2 flex-1" />
					<ChangeBar />
				</div>
				)}

				<div className="relative">
				<CommandMenu
					commands={matches}
					term={term ?? ""}
					active={active}
					onPick={pick}
					onHover={setActive}
				/>
				<ComposerShell
					fieldRef={field}
					value={text}
					onChange={(next) => {
						setText(next);
						// Any edit un-dismisses: Escape hid this list, it did not turn the feature off.
						setDismissed(false);
					}}
					onSubmit={() => void submit()}
					onKeyDown={(event) => {
						if (matches.length === 0) return;
						/*
						 * Never while an IME is composing.
						 *
						 * Enter commits a candidate in Chinese, Japanese and Korean input — taking it
						 * here would make the field unusable for typing the language most of this app
						 * is written in, and the bug would only appear for the people it appears for.
						 */
						if (event.nativeEvent.isComposing) return;

						if (event.key === "ArrowDown") {
							event.preventDefault();
							setActive((index) => (index + 1) % matches.length);
						} else if (event.key === "ArrowUp") {
							event.preventDefault();
							setActive((index) => (index - 1 + matches.length) % matches.length);
						} else if (event.key === "Enter" || event.key === "Tab") {
							event.preventDefault();
							pick(matches[Math.min(active, matches.length - 1)]);
						} else if (event.key === "Escape") {
							event.preventDefault();
							setDismissed(true);
						}
					}}
					placeholder="随心输入，或输入 / 使用命令"
					onFiles={(files) => void addFiles(files)}
					attachments={
						attachments.length > 0 ? (
							<div className="flex flex-wrap gap-2 px-4 pt-3.5">
								{attachments.map((attachment, index) => (
									<div key={attachment.id} className="relative">
										{/*
										 * A button, because it is one: clicking a thumbnail opens the picture.
										 * Its rectangle is what the viewer flies from, which is why the handler
										 * takes the event rather than just the index.
										 */}
										<button
											type="button"
											aria-label={`预览 ${attachment.name}`}
											onClick={(event) =>
												openFromEvent(
													event,
													attachments.map((a) => ({
														src: `data:${a.mimeType};base64,${a.data}`,
														alt: a.name,
														onReplace: (dataUrl: string) =>
															setAttachments((prev) =>
																prev.map((item) =>
																	item.id === a.id ? { ...item, ...fromDataUrl(dataUrl, item) } : item,
																),
															),
													})),
													index,
												)
											}
											className="block overflow-hidden rounded-lg border border-line transition-opacity duration-[var(--ly-t-quick)] hover:opacity-85"
										>
											<img
												src={`data:${attachment.mimeType};base64,${attachment.data}`}
												alt={attachment.name}
												className="h-[68px] w-[92px] object-cover"
											/>
										</button>
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
								className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-label transition-colors duration-[var(--ly-t-quick)] ${
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
								<span className="@max-[420px]:hidden">
									<RollingText>{PERMISSION_LABEL[permissionMode]}</RollingText>
								</span>
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
									className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-label text-ink-faint"
								>
									<ModelIcon model={model?.modelId} name={modelName} />
									<span className="min-w-0 truncate">{modelName ?? "未配置模型"}</span>
								</span>
							) : (
								<button
									type="button"
									onClick={modelMenu.toggle}
									data-ly-tip={modelName ?? "选择模型"}
									aria-haspopup="menu"
									aria-expanded={modelMenu.open}
									className={`flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-label transition-colors ${
										modelMenu.open ? "bg-card-hover text-ink" : "text-ink-muted hover:bg-card-hover hover:text-ink"
									}`}
								>
									{/* Keyed on the model, so picking a different house turns the mark over with
									    the label beside it rather than swapping under it. */}
									<ModelIcon
										key={modelId}
										model={model?.modelId}
										name={modelName}
										className={modelRolls ? "ly-roll" : ""}
									/>
									<RollingText className="min-w-0 truncate">{modelName ?? "选择模型"}</RollingText>
								</button>
							)}
							<button
								type="button"
								onClick={effortMenu.toggle}
								aria-haspopup="menu"
								aria-expanded={effortMenu.open}
								data-ly-tip={`推理强度：${effortLabel(settings?.thinking ?? "medium")}`}
								className={`mr-1.5 flex h-7 shrink-0 items-center rounded-md px-2 text-label transition-colors ${
									effortMenu.open ? "bg-card-hover text-ink" : "text-ink-faint hover:bg-card-hover hover:text-ink"
								}`}
							>
								<RollingText>{effortLabel(settings?.thinking ?? "medium")}</RollingText>
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
	busy,
}: {
	icon: React.ReactNode;
	label: string;
	onClick: (event: React.MouseEvent<HTMLElement>) => void;
	active?: boolean;
	/** Something is being changed about what this names; the label is held until it lands. */
	busy?: boolean;
}) {
	const rolls = useRolled(label);

	return (
		<button
			type="button"
			data-ly-tip={busy ? "正在切换分支…" : label}
			aria-haspopup="menu"
			aria-expanded={active}
			aria-busy={busy || undefined}
			onClick={onClick}
			/* Dimmed while it is being changed, so the name reads as "still this, for now". */
			className={`ly-scroll flex h-[26px] min-w-0 items-center gap-1.5 rounded-md px-2 text-label transition-[color,background-color,opacity] duration-[var(--ly-t-quick)] ${
				busy ? "opacity-60" : ""
			} ${active ? "bg-card-hover text-ink" : "text-ink-muted hover:bg-card-hover hover:text-ink"}`}
		>
			<span className="shrink-0 text-ink-faint">{icon}</span>
			{/* Keyed on the label so switching project or branch rolls the new one in. `ScrollText`
			    cannot take `RollingText` as a child — it measures the string to decide whether the
			    chip scrolls on hover — so the remount happens around it instead, on the same terms. */}
			<ScrollText key={label} text={label} className={`min-w-0 ${rolls ? "ly-roll" : ""}`} />
		</button>
	);
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

/**
 * Split an annotated `data:` URL back into the shape an attachment is stored in.
 *
 * The annotator always hands back PNG, whatever went in — flattening a JPEG with marks on it and
 * calling it a JPEG would re-compress the original a second time.
 */
function fromDataUrl(dataUrl: string, previous: { mimeType: string }): { data: string; mimeType: string } {
	const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
	if (!match) return { data: "", mimeType: previous.mimeType };
	return { mimeType: match[1], data: match[2] };
}
