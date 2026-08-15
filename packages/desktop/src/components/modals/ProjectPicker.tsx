import { Check, Folder, Plus, Search, X } from "lucide-react";
import { useState } from "react";
import { MenuBody, MenuItem, Popover, type Anchor } from "../Popover.tsx";
import { Scroller } from "../Scroller.tsx";
import { useLayout } from "../../layout.tsx";
import { useApp } from "../../store.ts";

/**
 * Project switcher, anchored to whatever opened it.
 *
 * It used to be a centred dialog reached from the app title, which made changing project feel
 * like a mode switch for the whole window. Hanging it off the composer's project chip keeps
 * the control next to the thing it scopes — the turn you are about to send.
 */
export function ProjectPicker({ anchor, onClose }: { anchor: Anchor; onClose: () => void }) {
	const settings = useApp((s) => s.settings);
	const workspace = useApp((s) => s.workspace);
	const openWorkspace = useApp((s) => s.openWorkspace);
	const pickWorkspace = useApp((s) => s.pickWorkspace);
	const clearWorkspace = useApp((s) => s.clearWorkspace);
	// Switching projects changes what is behind the drawer, so the drawer has to go with it.
	const { dismissNav } = useLayout();
	const [query, setQuery] = useState("");

	const projects = (settings?.projects ?? [])
		.filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.path.includes(query))
		.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);

	const choose = (action: () => void) => {
		action();
		onClose();
		dismissNav();
	};

	return (
		<Popover anchor={anchor} onClose={onClose} placement="top" align="start" width={288}>
			<div className="flex h-9 items-center gap-2 border-b border-line px-3">
				<Search size={13} strokeWidth={1.9} className="shrink-0 text-ink-faint" />
				<input
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="搜索项目"
					className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-ink-faint"
				/>
			</div>

			<Scroller className="max-h-[min(280px,42vh)]" contentClassName="p-1" fadeColor="var(--color-float)">
				{projects.map((project) => (
					<MenuItem
						key={project.path}
						icon={<Folder size={13} strokeWidth={1.8} />}
						title={project.path}
						selected={workspace?.path === project.path}
						trailing={
							workspace?.path === project.path ? (
								<Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" />
							) : undefined
						}
						onClick={() => choose(() => void openWorkspace(project.path))}
					>
						{project.name}
					</MenuItem>
				))}

				{projects.length === 0 && <p className="px-2.5 py-5 text-center text-[12px] text-ink-faint">还没有项目</p>}
			</Scroller>

			<div className="border-t border-line">
				<MenuBody>
					<MenuItem icon={<Plus size={13} strokeWidth={1.9} />} onClick={() => choose(() => void pickWorkspace())}>
						新建项目
					</MenuItem>
					<MenuItem icon={<X size={13} strokeWidth={1.9} />} onClick={() => choose(clearWorkspace)}>
						不在项目中工作
					</MenuItem>
				</MenuBody>
			</div>
		</Popover>
	);
}
