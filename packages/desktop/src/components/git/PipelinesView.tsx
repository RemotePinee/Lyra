/**
 * CI/CD & Release packaging pipeline view for the Git panel.
 *
 * Provides real-time workflow monitoring, platform matrix inspection,
 * job/step details with durations, and live status polling.
 */

import {
	Activity,
	AlertCircle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	ExternalLink,
	GitBranch,
	GitCommitHorizontal,
	Loader2,
	RefreshCw,
	Sparkles,
	Tag,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowRunStatus, WorkflowRunSummary } from "../../../electron/ipc-types.ts";
import { IconButton } from "../IconButton.tsx";
import { Scroller } from "../Scroller.tsx";
import { SkeletonList, useSlowLoad } from "../Skeleton.tsx";
import { relativeTime } from "./relative-time.ts";

interface PipelinesViewProps {
	cwd: string;
	onOpenRelease?: () => void;
}

/** Format duration in seconds or minutes */
function formatDuration(startedAt?: string, completedAt?: string): string {
	if (!startedAt) return "";
	const start = new Date(startedAt).getTime();
	const end = completedAt ? new Date(completedAt).getTime() : Date.now();
	const diff = Math.max(0, Math.floor((end - start) / 1000));
	if (diff < 60) return `${diff}s`;
	const mins = Math.floor(diff / 60);
	const secs = diff % 60;
	return `${mins}m ${secs}s`;
}

/** Render status badge & icon for workflow / job / step */
function StatusIcon({
	status,
	conclusion,
	size = 15,
}: {
	status: string;
	conclusion?: string | null;
	size?: number;
}) {
	if (status === "in_progress") {
		return <Loader2 size={size} className="animate-spin text-amber-500 shrink-0" />;
	}
	if (status === "queued" || status === "waiting") {
		return <Clock size={size} className="text-ink-faint shrink-0" />;
	}
	if (conclusion === "success") {
		return <CheckCircle2 size={size} className="text-emerald-500 shrink-0" />;
	}
	if (conclusion === "failure" || conclusion === "timed_out") {
		return <XCircle size={size} className="text-rose-500 shrink-0" />;
	}
	if (conclusion === "cancelled" || conclusion === "skipped") {
		return <AlertCircle size={size} className="text-ink-faint shrink-0" />;
	}
	return <Clock size={size} className="text-ink-faint shrink-0" />;
}

export function PipelinesView({ cwd, onOpenRelease }: PipelinesViewProps) {
	const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
	const [selectedRunDetail, setSelectedRunDetail] = useState<WorkflowRunStatus | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [expandedJobs, setExpandedJobs] = useState<Record<number, boolean>>({});

	const showSkeleton = useSlowLoad(loading);
	const activePollRef = useRef<NodeJS.Timeout | null>(null);

	const fetchRuns = useCallback(
		async (silent = false) => {
			if (!silent) setLoading(true);
			else setRefreshing(true);
			try {
				const list = await window.lyra.git.listWorkflowRuns(cwd, 25);
				setRuns(list);
				if (list.length > 0 && selectedRunId === null) {
					setSelectedRunId(list[0].id);
				}
			} finally {
				setLoading(false);
				setRefreshing(false);
			}
		},
		[cwd, selectedRunId],
	);

	const fetchDetail = useCallback(
		async (runId: number, silent = false) => {
			if (!silent) setDetailLoading(true);
			try {
				const detail = await window.lyra.git.workflowRunStatus(cwd, runId);
				setSelectedRunDetail(detail);
			} finally {
				setDetailLoading(false);
			}
		},
		[cwd],
	);

	// Initial load
	useEffect(() => {
		fetchRuns();
	}, [fetchRuns]);

	// Detail fetch on selection change
	useEffect(() => {
		if (selectedRunId) {
			fetchDetail(selectedRunId);
		} else {
			setSelectedRunDetail(null);
		}
	}, [selectedRunId, fetchDetail]);

	// Live polling when runs are in progress
	useEffect(() => {
		const hasActive =
			runs.some((r) => r.status === "in_progress" || r.status === "queued") ||
			selectedRunDetail?.status === "in_progress" ||
			selectedRunDetail?.status === "queued";

		if (hasActive) {
			activePollRef.current = setInterval(() => {
				fetchRuns(true);
				if (selectedRunId) fetchDetail(selectedRunId, true);
			}, 3500);
		} else {
			if (activePollRef.current) clearInterval(activePollRef.current);
		}

		return () => {
			if (activePollRef.current) clearInterval(activePollRef.current);
		};
	}, [runs, selectedRunDetail, selectedRunId, fetchRuns, fetchDetail]);

	const toggleJob = (jobId: number) => {
		setExpandedJobs((prev) => ({ ...prev, [jobId]: !prev[jobId] }));
	};

	// Skeletons during cold load
	if (showSkeleton) {
		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between border-b border-line px-3 py-2">
					<div className="flex items-center gap-2">
						<div className="h-4 w-20 animate-pulse rounded bg-fill-muted" />
					</div>
				</div>
				<div className="flex-1 p-3">
					<SkeletonList count={6} />
				</div>
			</div>
		);
	}

	// Empty state
	if (!loading && runs.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center p-6 text-center">
				<div className="relative mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-fill-muted border border-line">
					<Activity className="h-7 w-7 text-ink-faint" />
					<span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-500 ring-2 ring-panel">
						<Sparkles size={10} />
					</span>
				</div>
				<div className="text-ui font-medium text-ink">暂无流水线运行记录</div>
				<div className="mt-1 max-w-xs text-detail text-ink-muted leading-relaxed">
					尚未在此仓库检测到 GitHub Actions 构建或发版记录。你可以使用发版中心进行跨平台打包。
				</div>
				{onOpenRelease && (
					<button
						type="button"
						onClick={onOpenRelease}
						className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-detail font-medium text-ink shadow-sm border border-line hover:bg-fill-muted transition-colors cursor-pointer"
					>
						<Tag size={14} className="text-amber-500" />
						打开全功能发版中心
					</button>
				)}
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* Top Bar Actions */}
			<div className="flex items-center justify-between border-b border-line px-3 py-1.5 bg-surface/50">
				<div className="flex items-center gap-2">
					<Activity size={15} className="text-ink-muted" />
					<span className="text-detail font-medium text-ink">CI / CD 流水线</span>
					{runs.some((r) => r.status === "in_progress") && (
						<span className="flex items-center gap-1 text-micro font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-full">
							<span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
							运行中
						</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					<IconButton
						icon={<RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />}
						onClick={() => fetchRuns(false)}
						label="刷新流水线"
					/>
					{onOpenRelease && (
						<button
							type="button"
							onClick={onOpenRelease}
							className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-micro font-medium text-ink-muted hover:text-ink hover:bg-fill-muted border border-transparent hover:border-line transition-colors cursor-pointer"
							data-ly-tip="打开 Git 发版管理"
						>
							<Tag size={13} className="text-amber-500" />
							发版
						</button>
					)}
				</div>
			</div>

			{/* Main Split Layout: Left runs list, right detail/matrix */}
			<div className="flex flex-1 min-h-0 divide-x divide-line">
				{/* Left: Workflow Runs List */}
				<div className="w-[42%] flex flex-col min-h-0 bg-panel">
					<Scroller className="flex-1 p-1.5 space-y-1">
						{runs.map((run) => {
							const isSelected = run.id === selectedRunId;
							const isRunning = run.status === "in_progress";
							return (
								<button
									key={run.id}
									type="button"
									onClick={() => setSelectedRunId(run.id)}
									className={`w-full text-left p-2.5 rounded-lg border transition-all cursor-pointer ${
										isSelected
											? "bg-fill border-line shadow-xs"
											: "bg-transparent border-transparent hover:bg-fill-muted hover:border-line/60"
									}`}
								>
									<div className="flex items-start justify-between gap-1.5 mb-1">
										<div className="flex items-center gap-1.5 min-w-0">
											<StatusIcon status={run.status} conclusion={run.conclusion} size={14} />
											<span className="text-detail font-medium text-ink truncate leading-tight">
												{run.name || "Workflow"}
											</span>
										</div>
										<span className="text-micro text-ink-faint shrink-0 whitespace-nowrap">
											{relativeTime(run.createdAt)}
										</span>
									</div>

									<div className="text-micro text-ink-muted line-clamp-1 mb-1.5 pl-5">
										{run.displayTitle || "No commit message"}
									</div>

									<div className="flex items-center gap-2 text-micro text-ink-faint pl-5">
										<span className="flex items-center gap-0.5 truncate max-w-[100px]">
											<GitBranch size={11} className="shrink-0" />
											<span className="truncate">{run.headBranch}</span>
										</span>
										<span className="flex items-center gap-0.5 shrink-0">
											<GitCommitHorizontal size={11} className="shrink-0" />
											<span>{run.headSha ? run.headSha.slice(0, 7) : ""}</span>
										</span>
										{isRunning && (
											<span className="ml-auto text-amber-500 text-micro font-medium animate-pulse">
												构建中...
											</span>
										)}
									</div>
								</button>
							);
						})}
					</Scroller>
				</div>

				{/* Right: Selected Run Detail & Job Steps */}
				<div className="w-[58%] flex flex-col min-h-0 bg-surface/30">
					{selectedRunDetail ? (
						<Scroller className="flex-1 p-3 space-y-4">
							{/* Header Banner */}
							<div className="rounded-xl p-3 bg-panel border border-line shadow-xs space-y-2">
								<div className="flex items-start justify-between gap-2">
									<div className="flex items-center gap-2">
										<StatusIcon
											status={selectedRunDetail.status}
											conclusion={selectedRunDetail.conclusion}
											size={18}
										/>
										<div>
											<div className="text-ui font-semibold text-ink leading-tight">
												{selectedRunDetail.name || "工作流详情"}
											</div>
											<div className="text-micro text-ink-muted mt-0.5">
												ID: #{selectedRunDetail.id} · 事件: {selectedRunDetail.event || "push"}
											</div>
										</div>
									</div>
									<a
										href={selectedRunDetail.url}
										target="_blank"
										rel="noreferrer"
										className="inline-flex items-center gap-1 text-micro text-ink-muted hover:text-ink bg-fill-muted hover:bg-fill px-2 py-1 rounded-md border border-line transition-colors cursor-pointer"
										data-ly-tip="在 GitHub 中打开"
									>
										<ExternalLink size={12} />
										网页
									</a>
								</div>

								<div className="pt-1 text-detail text-ink leading-relaxed border-t border-line/50">
									{selectedRunDetail.displayTitle}
								</div>

								<div className="flex items-center justify-between text-micro text-ink-faint pt-1">
									<div className="flex items-center gap-2">
										<span className="flex items-center gap-1">
											<GitBranch size={12} />
											{selectedRunDetail.headBranch}
										</span>
										<span className="flex items-center gap-1">
											<GitCommitHorizontal size={12} />
											{selectedRunDetail.headSha?.slice(0, 7)}
										</span>
									</div>
									{selectedRunDetail.createdAt && (
										<span>触发于 {new Date(selectedRunDetail.createdAt).toLocaleTimeString()}</span>
									)}
								</div>
							</div>

							{/* Matrix / Jobs List */}
							<div className="space-y-2">
								<div className="text-micro font-semibold uppercase tracking-wider text-ink-faint px-1">
									构建任务与跨平台矩阵 ({selectedRunDetail.jobs.length})
								</div>

								{detailLoading && !selectedRunDetail.jobs.length ? (
									<div className="p-4">
										<SkeletonList count={3} />
									</div>
								) : selectedRunDetail.jobs.length === 0 ? (
									<div className="p-4 text-center text-detail text-ink-muted rounded-lg bg-panel border border-line">
										暂无 Job 详细数据（可能尚未调度就绪）
									</div>
								) : (
									<div className="space-y-1.5">
										{selectedRunDetail.jobs.map((job) => {
											const isExpanded = expandedJobs[job.id] ?? false;
											const hasSteps = (job.steps?.length ?? 0) > 0;
											const duration = formatDuration(job.startedAt, job.completedAt);

											return (
												<div
													key={job.id}
													className="rounded-lg border border-line bg-panel overflow-hidden transition-colors"
												>
													{/* Job Row Header */}
													<button
														type="button"
														onClick={() => toggleJob(job.id)}
														className="w-full flex items-center justify-between p-2.5 hover:bg-fill-muted/60 transition-colors cursor-pointer text-left"
													>
														<div className="flex items-center gap-2 min-w-0">
															<StatusIcon status={job.status} conclusion={job.conclusion} size={15} />
															<span className="text-detail font-medium text-ink truncate">
																{job.name}
															</span>
														</div>
														<div className="flex items-center gap-2 shrink-0">
															{duration && (
																<span className="text-micro text-ink-faint font-mono">
																	{duration}
																</span>
															)}
															{hasSteps && (
																<span className="text-ink-faint">
																	{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
																</span>
															)}
														</div>
													</button>

													{/* Step details accordion */}
													{isExpanded && hasSteps && (
														<div className="border-t border-line/60 bg-fill/40 p-2 space-y-1">
															{job.steps?.map((step) => {
																const stepDuration = formatDuration(step.startedAt, step.completedAt);
																return (
																	<div
																		key={step.number}
																		className="flex items-center justify-between py-1 px-2 rounded-md hover:bg-fill-muted/50 text-micro transition-colors"
																	>
																		<div className="flex items-center gap-2 min-w-0">
																			<StatusIcon
																				status={step.status}
																				conclusion={step.conclusion}
																				size={13}
																			/>
																			<span className="text-ink-muted truncate">
																				{step.name}
																			</span>
																		</div>
																		{stepDuration && (
																			<span className="text-ink-faint font-mono shrink-0">
																				{stepDuration}
																			</span>
																		)}
																	</div>
																);
															})}
														</div>
													)}
												</div>
											);
										})}
									</div>
								)}
							</div>
						</Scroller>
					) : (
						<div className="flex h-full flex-col items-center justify-center p-6 text-center text-ink-faint">
							<Loader2 className="h-6 w-6 animate-spin mb-2" />
							<span className="text-detail">加载流水线详情中...</span>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
