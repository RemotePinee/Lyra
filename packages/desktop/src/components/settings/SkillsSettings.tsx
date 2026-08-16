import { FolderOpen, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { PluginIcon } from "./PluginIcon.tsx";
import { useApp } from "../../store.ts";
import { Badge, Card, EmptyHint, GhostButton, SectionTitle } from "./controls.tsx";

const SOURCE_LABEL: Record<string, string> = { workspace: "项目", user: "用户", builtin: "内置" };

export function SkillsSettings({ filter = "" }: { filter?: string }) {
	const workspace = useApp((s) => s.workspace);
	const [scan, setScan] = useState<Awaited<ReturnType<typeof window.lyra.plugins.list>> | null>(null);

	// Scanned directly so the page works before any session exists.
	useEffect(() => {
		void window.lyra.plugins.list(workspace?.path ?? "").then(setScan);
	}, [workspace?.path]);

	// Name or description, because you remember a skill by either.
	const needle = filter.trim().toLowerCase();
	const skills = (scan?.skills ?? []).filter(
		(s) => !needle || `${s.name} ${s.description}`.toLowerCase().includes(needle),
	);
	const diagnostics = scan?.skillDiagnostics ?? [];

	return (
		<div>
			<header className="flex items-start justify-end pb-4">
				<div className="flex shrink-0 gap-2">
					<GhostButton
						onClick={() => void window.lyra.system.revealSkillsDir("user", workspace?.path ?? "")}
					>
						<span className="flex items-center gap-1.5">
							<FolderOpen size={12} strokeWidth={1.9} />
							用户目录
						</span>
					</GhostButton>
					{workspace && (
						<GhostButton onClick={() => void window.lyra.system.revealSkillsDir("workspace", workspace.path)}>
							<span className="flex items-center gap-1.5">
								<FolderOpen size={12} strokeWidth={1.9} />
								项目目录
							</span>
						</GhostButton>
					)}
				</div>
			</header>

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
					skills.map((skill) => (
						<div key={skill.path} className="border-b border-line-soft px-4 py-3.5 last:border-b-0">
							<div className="flex items-center gap-2">
								<PluginIcon name={skill.name} size={22} />
								<span className="font-mono text-label text-ink">{skill.name}</span>
								<Badge tone="muted">{SOURCE_LABEL[skill.source] ?? skill.source}</Badge>
								{skill.disableModelInvocation && <Badge tone="accent">仅手动调用</Badge>}
								<div className="flex-1" />
								<button
									type="button"
									onClick={() => void window.lyra.system.openPath(skill.path)}
									className="text-detail text-ink-faint transition-colors hover:text-ink"
								>
									打开
								</button>
							</div>
							<p className="mt-1 text-label leading-relaxed text-ink-muted">{skill.description}</p>
						</div>
					))
				)}
			</Card>
		</div>
	);
}
