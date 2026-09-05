import { useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Pressable,
	Text,
	View,
} from "react-native";
import { MobileCodeViewer } from "./MobileCodeViewer";
import { MobileGitChangesHeader } from "./MobileGitChangesHeader";
import type { SyncClient } from "./client";
import type { GitStatus, GitStatusFile } from "./protocol";
import { useGitActions } from "./useGitActions";

interface Props {
	status: GitStatus;
	cwd?: string;
	client: SyncClient | null;
	actionPending: boolean;
	setActionPending: (pending: boolean) => void;
	onReloadStatus: () => Promise<void>;
	onReloadHistory: () => Promise<void>;
}

export function MobileGitChangesTab({
	status,
	cwd,
	client,
	actionPending,
	setActionPending,
	onReloadStatus,
	onReloadHistory,
}: Props) {
	const [commitMsg, setCommitMsg] = useState("");
	const [expandedDiffFile, setExpandedDiffFile] = useState<{ path: string; staged: boolean } | null>(null);
	const [diffContent, setDiffContent] = useState<string | null>(null);
	const [loadingDiff, setLoadingDiff] = useState(false);

	const {
		handleStage,
		handleUnstage,
		handleStageAll,
		handleDiscard,
		handleCommit,
		handlePush,
		handlePull,
	} = useGitActions({
		cwd,
		client,
		status,
		actionPending,
		setActionPending,
		onReloadStatus,
		onReloadHistory,
		onClearExpandedDiff: (path) => {
			if (expandedDiffFile?.path === path) {
				setExpandedDiffFile(null);
				setDiffContent(null);
			}
		},
	});

	const handleToggleDiff = async (file: GitStatusFile, staged: boolean) => {
		if (!client || !cwd) return;
		if (expandedDiffFile?.path === file.path && expandedDiffFile.staged === staged) {
			setExpandedDiffFile(null);
			setDiffContent(null);
			return;
		}

		setExpandedDiffFile({ path: file.path, staged });
		setLoadingDiff(true);
		try {
			const diff = await client.gitDiff(cwd, file.path, staged);
			setDiffContent(diff || "（该文件无详细文本差异，可能是二进制文件或空改动）");
		} catch {
			setDiffContent("无法加载文件差异");
		} finally {
			setLoadingDiff(false);
		}
	};

	const statusBadge = (s: string) => {
		switch (s) {
			case "modified":
				return "M";
			case "added":
			case "untracked":
				return "A";
			case "deleted":
				return "D";
			case "renamed":
				return "R";
			default:
				return "•";
		}
	};

	const statusColor = (s: string) => {
		switch (s) {
			case "modified":
				return "text-accent";
			case "added":
			case "untracked":
				return "text-ok";
			case "deleted":
				return "text-danger";
			default:
				return "text-ink-muted";
		}
	};

	return (
		<FlatList
			data={[
				...status.staged.map((f) => ({ ...f, staged: true })),
				...status.unstaged.map((f) => ({ ...f, staged: false })),
			]}
			keyExtractor={(item: GitStatusFile & { staged: boolean }) =>
				`${item.staged ? "staged" : "unstaged"}-${item.path}`
			}
			showsVerticalScrollIndicator={false}
			initialNumToRender={15}
			maxToRenderPerBatch={10}
			windowSize={5}
			removeClippedSubviews={true}
			ListHeaderComponent={
				<MobileGitChangesHeader
					status={status}
					commitMsg={commitMsg}
					setCommitMsg={setCommitMsg}
					actionPending={actionPending}
					onPull={() => void handlePull()}
					onPush={() => void handlePush()}
					onCommit={() => void handleCommit(commitMsg, () => setCommitMsg(""))}
					onStageAll={() => void handleStageAll()}
					onReloadStatus={() => void onReloadStatus()}
				/>
			}
			renderItem={({ item: f }: { item: GitStatusFile & { staged: boolean } }) => {
				const isExpanded = Boolean(
					expandedDiffFile &&
						expandedDiffFile.path === f.path &&
						expandedDiffFile.staged === f.staged,
				);
				return (
					<View className="overflow-hidden bg-card">
						<Pressable
							onPress={() => void handleToggleDiff(f, f.staged)}
							className="flex-row items-center justify-between p-3 active:bg-card-hover"
						>
							<View className="flex-1 flex-row items-center gap-2 pr-2">
								<Text className={`font-mono text-[12px] font-bold ${statusColor(f.status)}`}>
									{statusBadge(f.status)}
								</Text>
								<Text className="flex-1 text-[13px] text-ink" numberOfLines={1}>
									{f.path}
								</Text>
								{!f.staged && (f.added > 0 || f.removed > 0) && (
									<View className="flex-row items-center gap-1">
										{f.added > 0 && <Text className="font-mono text-[10.5px] text-ok">+{f.added}</Text>}
										{f.removed > 0 && <Text className="font-mono text-[10.5px] text-danger">-{f.removed}</Text>}
									</View>
								)}
							</View>
							<View className="flex-row items-center gap-2">
								{f.staged ? (
									<Pressable
										onPress={(e) => {
											e.stopPropagation();
											void handleUnstage(f.path);
										}}
										disabled={actionPending}
										className="rounded bg-ok/15 px-2 py-1 active:opacity-75"
									>
										<Text className="text-[11px] font-semibold text-ok">取消</Text>
									</Pressable>
								) : (
									<>
										<Pressable
											onPress={(e) => {
												e.stopPropagation();
												handleDiscard(f.path);
											}}
											disabled={actionPending}
											className="rounded bg-danger/10 px-2 py-1 active:opacity-75"
										>
											<Text className="text-[11px] font-semibold text-danger">丢弃</Text>
										</Pressable>
										<Pressable
											onPress={(e) => {
												e.stopPropagation();
												void handleStage(f.path);
											}}
											disabled={actionPending}
											className="rounded bg-accent/15 px-2 py-1 active:opacity-75"
										>
											<Text className="text-[11px] font-semibold text-accent">暂存</Text>
										</Pressable>
									</>
								)}
								<Text className="text-[11px] text-ink-faint">{isExpanded ? "▴" : "▾"}</Text>
							</View>
						</Pressable>
						{isExpanded && (
							<View className="bg-shell/80 p-2">
								{loadingDiff ? (
									<ActivityIndicator size="small" className="py-4" />
								) : (
									<MobileCodeViewer code={diffContent || ""} />
								)}
							</View>
						)}
					</View>
				);
			}}
			ListFooterComponent={<View className="h-10" />}
		/>
	);
}
