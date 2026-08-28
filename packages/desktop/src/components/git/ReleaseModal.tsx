import { Check, CheckCircle2, ChevronRight, ExternalLink, Loader2, Sparkles, Tag, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReleaseInfo, WorkflowRunStatus } from "../../../electron/ipc-types.ts";
import { Overlay } from "../modals/Overlay.tsx";
import { Text } from "../Text.tsx";

interface ReleaseModalProps {
	cwd: string;
	onClose: () => void;
}

export function ReleaseModal({ cwd, onClose }: ReleaseModalProps) {
	const [info, setInfo] = useState<ReleaseInfo | null>(null);
	const [loading, setLoading] = useState(true);
	const [selectedType, setSelectedType] = useState<"patch" | "minor" | "major" | "custom">("patch");
	const [customVersion, setCustomVersion] = useState("");
	const [notes, setNotes] = useState("");
	const [generatingNotes, setGeneratingNotes] = useState(false);

	// Dry Run state
	const [dryRunId, setDryRunId] = useState<number | null>(null);
	const [dryRunStatus, setDryRunStatus] = useState<WorkflowRunStatus | null>(null);
	const [triggeringDryRun, setTriggeringDryRun] = useState(false);

	// Publishing state
	const [publishing, setPublishing] = useState(false);
	const [publishSuccess, setPublishSuccess] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Fetch repository release status on mount
	useEffect(() => {
		let alive = true;
		void (async () => {
			setLoading(true);
			try {
				const res = await window.lyra.git.releaseInfo(cwd);
				if (alive && res) {
					setInfo(res);
					setCustomVersion(res.suggestedVersion.patch);
				}
			} catch (err) {
				if (alive) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (alive) setLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [cwd]);

	const currentTargetVersion =
		selectedType === "custom"
			? customVersion.trim()
			: (info?.suggestedVersion[selectedType] ?? customVersion);

	// Generate Release notes with Agent prompt assistance or commit log template
	const handleGenerateNotes = useCallback(async () => {
		if (!info) return;
		setGeneratingNotes(true);
		try {
			const commits = info.commitsSinceTag;
			const commitLines = commits.map((c) => `- ${c.subject} (${c.shortSha}) by @${c.author}`).join("\n");

			// Build categorized notes outline
			const featCommits = commits.filter((c) => /^feat(\(.*\))?:/i.test(c.subject));
			const perfCommits = commits.filter((c) => /^(perf|style|refactor)(\(.*\))?:/i.test(c.subject));
			const fixCommits = commits.filter((c) => /^fix(\(.*\))?:/i.test(c.subject));
			const otherCommits = commits.filter(
				(c) => !featCommits.includes(c) && !perfCommits.includes(c) && !fixCommits.includes(c),
			);

			const sections: string[] = [];
			if (featCommits.length > 0) {
				sections.push(`### ✨ 新功能\n${featCommits.map((c) => `- ${c.subject}`).join("\n")}`);
			}
			if (perfCommits.length > 0) {
				sections.push(`### ⚡ 优化与重构\n${perfCommits.map((c) => `- ${c.subject}`).join("\n")}`);
			}
			if (fixCommits.length > 0) {
				sections.push(`### 🐛 问题修复\n${fixCommits.map((c) => `- ${c.subject}`).join("\n")}`);
			}
			if (otherCommits.length > 0) {
				sections.push(`### 📝 其它改动\n${otherCommits.map((c) => `- ${c.subject}`).join("\n")}`);
			}

			const generated = sections.length > 0 ? sections.join("\n\n") : commitLines || "无新增变更记录";
			setNotes(generated);
		} finally {
			setGeneratingNotes(false);
		}
	}, [info]);

	// Initialize default notes when info is loaded
	useEffect(() => {
		if (info && !notes) {
			void handleGenerateNotes();
		}
	}, [info, notes, handleGenerateNotes]);

	// Poll dry run status if dryRunId is set
	useEffect(() => {
		if (!dryRunId) return;
		let alive = true;
		const interval = setInterval(async () => {
			const status = await window.lyra.git.workflowRunStatus(cwd, dryRunId);
			if (alive && status) {
				setDryRunStatus(status);
				if (status.status === "completed") {
					clearInterval(interval);
				}
			}
		}, 3000);

		return () => {
			alive = false;
			clearInterval(interval);
		};
	}, [cwd, dryRunId]);

	const handleTriggerDryRun = async () => {
		setError(null);
		setTriggeringDryRun(true);
		const res = await window.lyra.git.triggerDryRun(cwd);
		setTriggeringDryRun(false);
		if (!res.ok) {
			setError(res.error ?? "触发 GitHub Actions 试运行失败");
			return;
		}
		if (res.runId) {
			setDryRunId(res.runId);
		}
	};

	const handlePublish = async () => {
		if (!currentTargetVersion) return;
		setError(null);
		setPublishing(true);

		// 1. Bump version files
		const bumpRes = await window.lyra.git.bumpVersion(cwd, currentTargetVersion);
		if (!bumpRes.ok) {
			setPublishing(false);
			setError(bumpRes.error ?? "更新 package.json 失败");
			return;
		}

		// 2. Publish git tag & push
		const pubRes = await window.lyra.git.publishReleaseTag(cwd, currentTargetVersion);
		setPublishing(false);
		if (!pubRes.ok) {
			setError(pubRes.error ?? "发布 Git Tag 失败");
			return;
		}

		setPublishSuccess(pubRes.tag ?? `v${currentTargetVersion}`);
	};

	return (
		<Overlay onClose={onClose} width={580}>
			<div className="flex flex-col max-h-[85vh] bg-float text-ink">
				{/* Header */}
				<div className="flex items-center justify-between border-b border-line px-4 py-3 shrink-0">
					<div className="flex items-center gap-2">
						<Tag size={16} strokeWidth={1.8} className="text-accent" />
						<Text size="body" weight="semibold">
							发版中心 (Release)
						</Text>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-md p-1 text-ink-muted hover:bg-card-hover hover:text-ink"
					>
						<X size={16} strokeWidth={1.8} />
					</button>
				</div>

				{/* Body Content */}
				<div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
					{loading && (
						<div className="flex items-center justify-center py-12">
							<Loader2 size={24} className="animate-spin text-ink-faint" />
						</div>
					)}

					{publishSuccess && (
						<div className="rounded-xl border border-success/30 bg-success/10 p-4 text-center space-y-2">
							<div className="flex items-center justify-center gap-2 text-success font-medium">
								<CheckCircle2 size={18} />
								<span>版本 {publishSuccess} 已成功打 Tag 并推送到远程！</span>
							</div>
							<Text size="detail" tone="muted">
								GitHub Actions Release 正在自动多平台打包并发布产物。
							</Text>
							<button
								type="button"
								onClick={onClose}
								className="mt-2 rounded-lg bg-ink px-4 py-1.5 text-detail font-medium text-shell hover:opacity-90"
							>
								完成
							</button>
						</div>
					)}

					{!loading && !publishSuccess && info && (
						<>
							{/* Current info & Target Version Picker */}
							<div className="rounded-xl border border-line bg-card/40 p-3.5 space-y-3">
								<div className="flex items-center justify-between text-detail">
									<span className="text-ink-muted">
										当前版本: <span className="font-mono text-ink">{info.currentVersion}</span>
									</span>
									<span className="text-ink-muted">
										最新标签: <span className="font-mono text-ink">{info.latestTag ?? "无"}</span>
									</span>
									<span className="text-ink-muted">
										未发布提交:{" "}
										<span className="font-mono text-ink font-semibold">
											{info.commitsSinceTag.length}
										</span>
									</span>
								</div>

								<div>
									<Text size="caption" tone="muted" className="mb-1.5 block">
										目标版本号:
									</Text>
									<div className="grid grid-cols-4 gap-1.5">
										{(["patch", "minor", "major"] as const).map((type) => (
											<button
												key={type}
												type="button"
												onClick={() => setSelectedType(type)}
												className={`flex flex-col items-center justify-center py-1.5 rounded-lg border text-detail transition-colors ${
													selectedType === type
														? "border-accent bg-accent/10 text-accent font-medium"
														: "border-line bg-card hover:bg-card-hover text-ink"
												}`}
											>
												<span className="uppercase text-[10px] tracking-wider text-ink-faint">
													{type}
												</span>
												<span className="font-mono">{info.suggestedVersion[type]}</span>
											</button>
										))}
										<button
											type="button"
											onClick={() => setSelectedType("custom")}
											className={`flex flex-col items-center justify-center py-1.5 rounded-lg border text-detail transition-colors ${
												selectedType === "custom"
													? "border-accent bg-accent/10 text-accent font-medium"
													: "border-line bg-card hover:bg-card-hover text-ink"
											}`}
										>
											<span className="uppercase text-[10px] tracking-wider text-ink-faint">
												自定义
											</span>
											<span className="font-mono">{customVersion || "x.y.z"}</span>
										</button>
									</div>

									{selectedType === "custom" && (
										<input
											type="text"
											value={customVersion}
											onChange={(e) => setCustomVersion(e.target.value)}
											placeholder="0.7.4"
											className="mt-2 w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-detail font-mono text-ink focus:border-accent focus:outline-none"
										/>
									)}
								</div>
							</div>

							{/* Release Notes */}
							<div className="space-y-1.5">
								<div className="flex items-center justify-between">
									<Text size="caption" tone="muted">
										版本更新日志 (Release Notes):
									</Text>
									<button
										type="button"
										onClick={handleGenerateNotes}
										disabled={generatingNotes}
										className="flex items-center gap-1 text-[11px] text-accent hover:underline disabled:opacity-50"
									>
										<Sparkles size={11} />
										<span>重新提取</span>
									</button>
								</div>
								<textarea
									value={notes}
									onChange={(e) => setNotes(e.target.value)}
									rows={6}
									className="w-full rounded-xl border border-line bg-card/60 p-2.5 text-detail font-mono text-ink focus:border-accent focus:outline-none resize-none"
									placeholder="在此编辑发版说明..."
								/>
							</div>

							{/* Pre-flight Checks / GitHub Actions Dry Run */}
							<div className="rounded-xl border border-line bg-card/30 p-3 space-y-2">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-1.5">
										<Text size="detail" weight="medium">
											GitHub Actions 跨平台打包试运行 (Dry Run)
										</Text>
									</div>
									<button
										type="button"
										onClick={handleTriggerDryRun}
										disabled={triggeringDryRun || dryRunStatus?.status === "in_progress"}
										className="flex items-center gap-1 rounded-md bg-card px-2.5 py-1 text-detail text-ink border border-line hover:bg-card-hover disabled:opacity-50"
									>
										{triggeringDryRun ? (
											<Loader2 size={12} className="animate-spin" />
										) : (
											<Sparkles size={12} />
										)}
										<span>
											{dryRunStatus?.status === "in_progress" ? "运行中..." : "触发 Dry Run 校验"}
										</span>
									</button>
								</div>

								{dryRunStatus && (
									<div className="rounded-lg border border-line/60 bg-float/60 p-2 text-detail space-y-1.5">
										<div className="flex items-center justify-between text-caption">
											<span className="text-ink-muted">
												状态:{" "}
												<span className="font-medium text-ink">
													{dryRunStatus.status === "completed"
														? dryRunStatus.conclusion === "success"
															? "全部平台构建成功 ✓"
															: "构建失败 ✗"
														: "正在构建各平台产物..."}
												</span>
											</span>
											{dryRunStatus.url && (
												<a
													href={dryRunStatus.url}
													target="_blank"
													rel="noreferrer"
													className="flex items-center gap-0.5 text-accent hover:underline"
												>
													<span>查看 Actions 日志</span>
													<ExternalLink size={10} />
												</a>
											)}
										</div>

										{dryRunStatus.jobs.length > 0 && (
											<div className="grid grid-cols-3 gap-1 pt-1">
												{dryRunStatus.jobs.map((job) => (
													<div
														key={job.name}
														className="flex items-center gap-1 text-[11px] text-ink-muted"
													>
														{job.status === "completed" ? (
															job.conclusion === "success" ? (
																<Check size={12} className="text-success shrink-0" />
															) : (
																<XCircle size={12} className="text-danger shrink-0" />
															)
														) : (
															<Loader2
																size={12}
																className="animate-spin text-accent shrink-0"
															/>
														)}
														<span className="truncate">{job.name}</span>
													</div>
												))}
											</div>
										)}
									</div>
								)}
							</div>

							{error && (
								<div className="rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-detail text-danger">
									{error}
								</div>
							)}
						</>
					)}
				</div>

				{/* Footer Actions */}
				{!publishSuccess && (
					<div className="flex items-center justify-between border-t border-line px-4 py-3 shrink-0 bg-card/20">
						<Text size="detail" tone="muted">
							目标: <span className="font-mono font-semibold text-ink">v{currentTargetVersion}</span>
						</Text>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={onClose}
								className="rounded-lg border border-line bg-card px-3 py-1.5 text-detail font-medium text-ink hover:bg-card-hover"
							>
								取消
							</button>
							<button
								type="button"
								onClick={handlePublish}
								disabled={publishing || !currentTargetVersion || loading}
								className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-detail font-medium text-white shadow-sm hover:opacity-90 disabled:opacity-50"
							>
								{publishing && <Loader2 size={13} className="animate-spin" />}
								<span>确认并发布 (打 Tag & Push)</span>
								<ChevronRight size={14} />
							</button>
						</div>
					</div>
				)}
			</div>
		</Overlay>
	);
}
