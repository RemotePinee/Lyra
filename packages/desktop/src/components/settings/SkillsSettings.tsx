import { FolderOpen, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../../store.ts";
import { Badge, Card, EmptyHint, GhostButton, SectionTitle } from "./controls.tsx";

const SOURCE_LABEL: Record<string, string> = { workspace: "项目", user: "用户", builtin: "内置" };

export function SkillsSettings() {
	const workspace = useApp((s) => s.workspace);
	const [scan, setScan] = useState<Awaited<ReturnType<typeof window.deepwise.plugins.list>> | null>(null);

	// Scanned directly so the page works before any session exists.
	useEffect(() => {
		void window.deepwise.plugins.list(workspace?.path ?? "").then(setScan);
	}, [workspace?.path]);

	const skills = scan?.skills ?? [];
	const diagnostics = scan?.skillDiagnostics ?? [];

	return (
		<div className="pt-8">
			<header className="flex items-start justify-between pb-7">
				<div>
					<h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">技能</h1>
					<p className="mt-2 max-w-[560px] text-[13px] leading-relaxed text-ink-muted">
						技能是放在 <code className="rounded bg-card px-1 py-0.5 font-mono text-[12px]">SKILL.md</code>{" "}
						里的一段说明书。DeepWise 只把名称和描述放进系统提示，模型判断任务匹配时才通过{" "}
						<code className="rounded bg-card px-1 py-0.5 font-mono text-[12px]">skill</code> 工具把正文读进来。
					</p>
				</div>
				<div className="flex shrink-0 gap-2 pt-1">
					<GhostButton
						onClick={() => void window.deepwise.system.revealSkillsDir("user", workspace?.path ?? "")}
					>
						<span className="flex items-center gap-1.5">
							<FolderOpen size={12} strokeWidth={1.9} />
							用户目录
						</span>
					</GhostButton>
					{workspace && (
						<GhostButton onClick={() => void window.deepwise.system.revealSkillsDir("workspace", workspace.path)}>
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
						<div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-accent">
							<TriangleAlert size={13} strokeWidth={1.9} />
							{diagnostics.length} 个技能未能加载
						</div>
						{diagnostics.map((diagnostic) => (
							<div key={diagnostic.path} className="py-0.5 text-[12px] text-accent/85">
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
								<Sparkles size={14} strokeWidth={1.8} className="shrink-0 text-violet" />
								<span className="font-mono text-[13px] text-ink">{skill.name}</span>
								<Badge tone="muted">{SOURCE_LABEL[skill.source] ?? skill.source}</Badge>
								{skill.disableModelInvocation && <Badge tone="accent">仅手动调用</Badge>}
								<div className="flex-1" />
								<button
									type="button"
									onClick={() => void window.deepwise.system.openPath(skill.path)}
									className="text-[12px] text-ink-faint transition-colors hover:text-ink"
								>
									打开
								</button>
							</div>
							<p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{skill.description}</p>
						</div>
					))
				)}
			</Card>

			<div className="mt-6 rounded-[12px] border border-line bg-card/30 p-4">
				<div className="mb-2 text-[12.5px] text-ink">SKILL.md 格式</div>
				<pre className="overflow-x-auto rounded-lg bg-shell p-3 font-mono text-[11.5px] leading-relaxed text-ink-muted">{`---
name: pdf-report
description: 生成带图表的 PDF 报表。当用户要求导出报表、生成 PDF 时使用。
allowed-tools: [read, write, bash]
---

# 生成 PDF 报表

1. 先用 \`read\` 确认数据源结构
2. 用 reportlab 生成，模板在 templates/report.py
3. 输出到 out/report-<日期>.pdf 并把路径回给用户`}</pre>
			</div>
		</div>
	);
}
