import { Check, GitBranch, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { BranchList } from "../../../electron/ipc-types.ts";
import { MenuItem, MenuLabel, Popover, type Anchor } from "../Popover.tsx";
import { Scroller } from "../Scroller.tsx";
import { ScrollText } from "../ScrollText.tsx";
import { useApp } from "../../store.ts";

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

	const [branches, setBranches] = useState<BranchList | null>(null);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);

	useEffect(() => {
		if (!workspace) return;
		let live = true;
		void window.deepwise.git.branches(workspace.path).then((list) => {
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
		const result = await window.deepwise.git.switchBranch(workspace.path, target);
		setBusy(null);
		if (!result.ok) {
			notify(result.error ?? "切换分支失败", "error");
			return;
		}
		await refreshWorkspace();
		onClose();
	}

	return (
		<Popover anchor={anchor} onClose={onClose} placement="top" align="start" width={272}>
			<div className="flex h-9 items-center gap-2 border-b border-line px-3">
				<Search size={13} strokeWidth={1.9} className="shrink-0 text-ink-faint" />
				<input
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="搜索分支"
					className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-ink-faint"
				/>
			</div>

			<Scroller className="max-h-[min(300px,44vh)]" contentClassName="p-1" fadeColor="var(--color-float)">
				{!branches && <p className="px-2.5 py-5 text-center text-[12px] text-ink-faint">读取分支…</p>}

				{branches && local.length === 0 && remote.length === 0 && (
					<p className="px-2.5 py-5 text-center text-[12px] text-ink-faint">
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
			</Scroller>
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
			icon={<GitBranch size={13} strokeWidth={1.8} className={busy ? "dw-pulse" : undefined} />}
			title={name}
			selected={current}
			disabled={busy}
			trailing={current ? <Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" /> : undefined}
			onClick={onSelect}
		>
			<ScrollText text={name} className="font-mono text-[12px]" />
		</MenuItem>
	);
}
