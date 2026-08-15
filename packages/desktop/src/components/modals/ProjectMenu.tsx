import { Archive, FolderOpen, GitBranch, PinOff, Pin, Settings2, X } from "lucide-react";
import { useState } from "react";
import { MenuBody, MenuItem, MenuSeparator, Popover, type Anchor } from "../Popover.tsx";
import { useApp } from "../../store.ts";

/**
 * Per-project actions, hung off the row they act on.
 *
 * Everything here is either reversible (pinning, archiving) or leaves the working tree alone
 * (removing only forgets the entry). Nothing on this menu deletes a directory.
 */
export function ProjectMenu({
	anchor,
	path,
	name,
	onClose,
}: {
	anchor: Anchor;
	path: string;
	name: string;
	onClose: () => void;
}) {
	const settings = useApp((s) => s.settings);
	const sessions = useApp((s) => s.sessions);
	const setPinned = useApp((s) => s.setProjectPinned);
	const removeProject = useApp((s) => s.removeProject);
	const archiveProjectSessions = useApp((s) => s.archiveProjectSessions);
	const renameProject = useApp((s) => s.renameProject);
	const refreshWorkspace = useApp((s) => s.refreshWorkspace);
	const notify = useApp((s) => s.notify);

	const [mode, setMode] = useState<"menu" | "rename" | "worktree">("menu");
	const [draft, setDraft] = useState(name);
	const [busy, setBusy] = useState(false);

	const pinned = settings?.projects.find((p) => p.path === path)?.pinned ?? false;
	const liveSessions = sessions.filter((s) => s.cwd === path && !s.archived).length;

	async function makeWorktree() {
		const branch = draft.trim();
		if (!branch || busy) return;
		setBusy(true);
		const result = await window.lyra.git.createWorktree(path, branch);
		setBusy(false);
		if (!result.ok) {
			notify(result.error ?? "创建工作树失败", "error");
			return;
		}
		notify(`已创建工作树 ${result.path}`);
		await refreshWorkspace();
		onClose();
	}

	if (mode === "rename" || mode === "worktree") {
		const worktree = mode === "worktree";
		return (
			<Popover anchor={anchor} onClose={onClose} placement="right" width={260}>
				<form
					className="p-2.5"
					onSubmit={(event) => {
						event.preventDefault();
						if (worktree) void makeWorktree();
						else {
							void renameProject(path, draft);
							onClose();
						}
					}}
				>
					<label className="block pb-1.5 text-[11.5px] text-ink-faint">
						{worktree ? "新工作树的分支名" : "项目名称"}
					</label>
					<input
						autoFocus
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								setMode("menu");
								setDraft(name);
							}
						}}
						placeholder={worktree ? "feature/…" : name}
						className="h-8 w-full rounded-lg border border-line bg-input px-2.5 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-ink-faint"
					/>
					{worktree && (
						<p className="pt-1.5 text-[11px] leading-relaxed text-ink-faint">
							会在项目同级目录新建一个工作树，独立分支，不影响当前签出的内容。
						</p>
					)}
					<div className="flex justify-end gap-1.5 pt-2.5">
						<button
							type="button"
							onClick={() => {
								setMode("menu");
								setDraft(name);
							}}
							className="h-7 rounded-lg px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
						>
							取消
						</button>
						<button
							type="submit"
							disabled={busy || !draft.trim()}
							className="h-7 rounded-lg bg-ink px-2.5 text-[12px] font-medium text-shell transition-opacity hover:opacity-90 disabled:opacity-45"
						>
							{busy ? "创建中…" : worktree ? "创建" : "保存"}
						</button>
					</div>
				</form>
			</Popover>
		);
	}

	return (
		<Popover anchor={anchor} onClose={onClose} placement="right" width={184}>
			<MenuBody>
				<MenuItem
					icon={pinned ? <PinOff size={13} strokeWidth={1.8} /> : <Pin size={13} strokeWidth={1.8} />}
					onClick={() => {
						void setPinned(path, !pinned);
						onClose();
					}}
				>
					{pinned ? "取消置顶项目" : "置顶项目"}
				</MenuItem>
				<MenuItem
					icon={<FolderOpen size={13} strokeWidth={1.8} />}
					onClick={() => {
						void window.lyra.workspace.reveal(path);
						onClose();
					}}
				>
					在 Finder 中显示
				</MenuItem>
				<MenuItem
					icon={<GitBranch size={13} strokeWidth={1.8} />}
					onClick={() => {
						setDraft("");
						setMode("worktree");
					}}
				>
					创建永久工作树
				</MenuItem>
				<MenuItem
					icon={<Settings2 size={13} strokeWidth={1.8} />}
					onClick={() => {
						setDraft(name);
						setMode("rename");
					}}
				>
					编辑项目
				</MenuItem>

				<MenuSeparator />

				<MenuItem
					icon={<Archive size={13} strokeWidth={1.8} />}
					hint={liveSessions > 0 ? String(liveSessions) : undefined}
					disabled={liveSessions === 0}
					onClick={() => {
						void archiveProjectSessions(path);
						onClose();
					}}
				>
					归档聊天
				</MenuItem>
				<MenuItem
					icon={<X size={13} strokeWidth={1.9} />}
					danger
					onClick={() => {
						void removeProject(path);
						onClose();
					}}
				>
					移除
				</MenuItem>
			</MenuBody>
		</Popover>
	);
}
