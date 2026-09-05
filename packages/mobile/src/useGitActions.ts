import { Alert } from "react-native";
import type { SyncClient } from "./client";
import { haptic } from "./haptics";
import type { GitStatus } from "./protocol";

interface UseGitActionsParams {
	cwd?: string;
	client: SyncClient | null;
	status: GitStatus | null;
	actionPending: boolean;
	setActionPending: (pending: boolean) => void;
	onReloadStatus: () => Promise<void>;
	onReloadHistory: () => Promise<void>;
	onClearExpandedDiff?: (path: string) => void;
}

export function useGitActions({
	cwd,
	client,
	status,
	actionPending,
	setActionPending,
	onReloadStatus,
	onReloadHistory,
	onClearExpandedDiff,
}: UseGitActionsParams) {
	const handleStage = async (path: string) => {
		if (!client || !cwd || actionPending) return;
		haptic.tap();
		setActionPending(true);
		try {
			const res = await client.gitStage(cwd, [path]);
			if (!res.ok) Alert.alert("暂存失败", res.error || "未知错误");
			else await onReloadStatus();
		} finally {
			setActionPending(false);
		}
	};

	const handleUnstage = async (path: string) => {
		if (!client || !cwd || actionPending) return;
		haptic.tap();
		setActionPending(true);
		try {
			const res = await client.gitUnstage(cwd, [path]);
			if (!res.ok) Alert.alert("取消暂存失败", res.error || "未知错误");
			else await onReloadStatus();
		} finally {
			setActionPending(false);
		}
	};

	const handleStageAll = async () => {
		if (!client || !cwd || !status || actionPending) return;
		const paths = status.unstaged.map((f) => f.path);
		if (paths.length === 0) return;
		haptic.impact();
		setActionPending(true);
		try {
			const res = await client.gitStage(cwd, paths);
			if (!res.ok) Alert.alert("全选暂存失败", res.error || "未知错误");
			else await onReloadStatus();
		} finally {
			setActionPending(false);
		}
	};

	const handleDiscard = (path: string) => {
		if (!client || !cwd || actionPending) return;
		Alert.alert(
			"丢弃修改",
			`确定要丢弃对 ${path} 的所有修改吗？此操作无法撤销。`,
			[
				{ text: "取消", style: "cancel" },
				{
					text: "丢弃",
					style: "destructive",
					onPress: async () => {
						setActionPending(true);
						try {
							const res = await client.gitDiscard(cwd, [path]);
							if (!res.ok) Alert.alert("丢弃失败", res.error || "未知错误");
							else {
								onClearExpandedDiff?.(path);
								await onReloadStatus();
							}
						} finally {
							setActionPending(false);
						}
					},
				},
			],
		);
	};

	const handleCommit = async (commitMsg: string, onCommitSuccess: () => void) => {
		if (!client || !cwd || !status || actionPending) return;
		if (!commitMsg.trim()) {
			Alert.alert("提示", "请输入提交信息");
			return;
		}
		if (status.staged.length === 0) {
			Alert.alert("提示", "暂存区没有文件，请先暂存修改");
			return;
		}
		haptic.impact();
		setActionPending(true);
		try {
			const res = await client.gitCommit(cwd, commitMsg.trim());
			if (!res.ok) {
				Alert.alert("提交失败", res.error || "未知错误");
			} else {
				haptic.success();
				onCommitSuccess();
				await onReloadStatus();
				void onReloadHistory();
			}
		} finally {
			setActionPending(false);
		}
	};

	const handlePush = async () => {
		if (!client || !cwd || actionPending) return;
		haptic.impact();
		setActionPending(true);
		try {
			const res = await client.gitPush(cwd);
			if (!res.ok) Alert.alert("推送失败", res.error || "未知错误");
			else {
				haptic.success();
				Alert.alert("成功", "已成功推送至远程分支");
				await onReloadStatus();
			}
		} finally {
			setActionPending(false);
		}
	};

	const handlePull = async () => {
		if (!client || !cwd || actionPending) return;
		haptic.impact();
		setActionPending(true);
		try {
			const res = await client.gitPull(cwd);
			if (!res.ok) Alert.alert("拉取失败", res.error || "未知错误");
			else {
				haptic.success();
				Alert.alert("成功", "已成功拉取最新代码");
				await onReloadStatus();
				void onReloadHistory();
			}
		} finally {
			setActionPending(false);
		}
	};

	return {
		handleStage,
		handleUnstage,
		handleStageAll,
		handleDiscard,
		handleCommit,
		handlePush,
		handlePull,
	};
}
