import { Check, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import type { BranchList } from "../../../electron/ipc-types.ts";
import { MENU_MAX_HEIGHT, MenuBody, MenuItem, MenuLabel, MenuSearch, Popover, type Anchor } from "../Popover.tsx";
import { ScrollText } from "../ScrollText.tsx";
import { useApp } from "../../store.ts";

/**
 * The last list seen for a workspace, so reopening the menu does not start from nothing.
 *
 * Deliberately module-level and not persisted. It exists to make the second open instant and
 * the right size — branches change, so it is shown while the real list is being fetched and
 * replaced the moment it arrives.
 */
const lastSeen = new Map<string, BranchList>();

/**
 * Branch switcher for the composer's branch chip.
 *
 * Checking out is refused rather than forced when the working tree would be clobbered — git's
 * own message says exactly which files are in the way, so it is surfaced verbatim instead of
 * being replaced with a generic failure.
 */
export function BranchMenu({ anchor, onClose }: { anchor: Anchor; onClose: () => void }) {
	const workspace = useApp((s) => s.workspace);
	const refreshWorkspace = useApp((s) => s.refreshWorkspace);
	const notify = useApp((s) => s.notify);

	const [branches, setBranches] = useState<BranchList | null>(
		() => (workspace ? (lastSeen.get(workspace.path) ?? null) : null),
	);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);

	useEffect(() => {
		if (!workspace) return;
		let live = true;
		void window.lyra.git.branches(workspace.path).then((list) => {
			lastSeen.set(workspace.path, list);
			if (live) setBranches(list);
		});
		return () => {
			live = false;
		};
	}, [workspace]);

	const needle = query.trim().toLowerCase();
	const match = (name: string) => !needle || name.toLowerCase().includes(needle);
	const local = (branches?.local ?? []).filter(match);
	const remote = (branches?.remote ?? []).filter(match);

	async function switchTo(branch: string) {
		if (!workspace || busy) return;
		setBusy(branch);
		// A remote branch is checked out under its short name; git sets up tracking itself.
		const target = branch.includes("/") && !branches?.local.includes(branch)
			? branch.split("/").slice(1).join("/")
			: branch;
		const result = await window.lyra.git.switchBranch(workspace.path, target);
		setBusy(null);
		if (!result.ok) {
			notify(result.error ?? "切换分支失败", "error");
			return;
		}
		await refreshWorkspace();
		onClose();
	}

	return (
		<Popover
			anchor={anchor}
			onClose={onClose}
			placement="top"
			align="start"
			width="wide"
			maxHeight={MENU_MAX_HEIGHT}
			label="切换分支"
			header={<MenuSearch value={query} onChange={setQuery} placeholder="搜索分支" />}
		>
			<MenuBody>
				{/*
				 * Rows, not a line of text.
				 *
				 * A single "读取分支…" is one row tall, and the list that replaces it is six or ten —
				 * so the menu opened, sat still for a moment, then shoved itself open. Standing in
				 * the shape of what is coming means the box is the right size from the first frame
				 * and only its contents change. Same reason the context breakdown does it.
				 */}
				{!branches &&
					[0, 1, 2, 3, 4].map((i) => (
						<div key={i} className="flex h-[30px] items-center gap-2 px-2">
							<span className="ly-pulse h-[13px] w-[13px] shrink-0 rounded bg-card" />
							<span
								className="ly-pulse h-[11px] rounded bg-card"
								style={{ width: `${58 - i * 7}%` }}
							/>
						</div>
					))}

				{branches && local.length === 0 && remote.length === 0 && (
					<p className="px-2.5 py-5 text-center text-detail text-ink-faint">
						{branches.local.length === 0 ? "当前项目不是 Git 仓库" : "没有匹配的分支"}
					</p>
				)}

				{local.map((branch) => (
					<Row
						key={branch}
						name={branch}
						current={branch === branches?.current}
						busy={busy === branch}
						onSelect={() => void switchTo(branch)}
					/>
				))}

				{remote.length > 0 && (
					<>
						<MenuLabel>远程</MenuLabel>
						{remote.map((branch) => (
							<Row key={branch} name={branch} busy={busy === branch} onSelect={() => void switchTo(branch)} />
						))}
					</>
				)}
			</MenuBody>
		</Popover>
	);
}

function Row({
	name,
	current,
	busy,
	onSelect,
}: {
	name: string;
	current?: boolean;
	busy?: boolean;
	onSelect: () => void;
}) {
	return (
		<MenuItem
			icon={<GitBranch size={13} strokeWidth={1.8} className={busy ? "ly-pulse" : undefined} />}
			title={name}
			selected={current}
			disabled={busy}
			trailing={current ? <Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" /> : undefined}
			onClick={onSelect}
		>
			<ScrollText text={name} className="font-mono text-detail" />
		</MenuItem>
	);
}
