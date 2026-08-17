import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { PluginIcon } from "./PluginIcon.tsx";
import { useApp } from "../../store.ts";
import { Badge, Card, EmptyHint, ListRow, SectionTitle } from "./controls.tsx";

export function SkillsSettings({ filter = "" }: { filter?: string }) {
	const workspace = useApp((s) => s.workspace);
	// A plugin carries skills, so installing one moves this list without touching this page.
	const extensionsNonce = useApp((s) => s.extensionsNonce);
	const [scan, setScan] = useState<Awaited<ReturnType<typeof window.lyra.plugins.list>> | null>(null);

	// Scanned directly so the page works before any session exists.
	useEffect(() => {
		void window.lyra.plugins.list(workspace?.path ?? "").then(setScan);
	}, [workspace?.path, extensionsNonce]);

	// Name or description, because you remember a skill by either.
	const needle = filter.trim().toLowerCase();
	const skills = (scan?.skills ?? []).filter(
		(s) => !needle || `${s.name} ${s.description}`.toLowerCase().includes(needle),
	);
	const diagnostics = scan?.skillDiagnostics ?? [];

	return (
		<div>
			{/* The two directory buttons that used to sit here are in the page's ⋯ now — three tabs
			    each opening with its own pair of them was a header that said nothing about the tab. */}
			{diagnostics.length > 0 && (
				<Card className="mb-6 border-accent/35 bg-accent/6">
					<div className="px-4 py-3">
						<div className="mb-2 flex items-center gap-1.5 text-label text-accent">
							<TriangleAlert size={13} strokeWidth={1.9} />
							{diagnostics.length} 个技能未能加载
						</div>
						{diagnostics.map((diagnostic) => (
							<div key={diagnostic.path} className="py-0.5 text-detail text-accent/85">
								<span className="font-mono">{diagnostic.path}</span> — {diagnostic.message}
							</div>
						))}
					</div>
				</Card>
			)}

			<SectionTitle>已安装（{skills.length}）</SectionTitle>
			<Card>
				{skills.length === 0 ? (
					<EmptyHint>
						还没有技能。
						<br />
						在上面的目录里新建 <span className="font-mono">{"<技能名>/SKILL.md"}</span>，写上 name 和 description 即可。
					</EmptyHint>
				) : (
					/*
					 * The same row as the plugin list, because it is the same kind of thing: a mark, a
					 * name, one line, and the row itself opens it. The badges are gone except the one
					 * that changes behaviour — where a skill came from is on its own page, but a skill
					 * the model is not allowed to reach for is a fact about what it will do.
					 */
					skills.map((skill) => (
						<ListRow
							key={skill.path}
							icon={<PluginIcon name={skill.name} size={28} />}
							title={
								<span className="flex min-w-0 items-center gap-2">
									<span className="truncate font-mono">{skill.name}</span>
									{skill.disableModelInvocation && <Badge tone="accent">仅手动调用</Badge>}
								</span>
							}
							detail={skill.description}
							onOpen={() => void window.lyra.system.openPath(skill.path)}
							openLabel={`打开 ${skill.name}`}
						/>
					))
				)}
			</Card>
		</div>
	);
}
