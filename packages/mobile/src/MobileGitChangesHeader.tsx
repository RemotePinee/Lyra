import { Pressable, Text, TextInput, View } from "react-native";
import type { GitStatus } from "./protocol";

interface Props {
	status: GitStatus;
	commitMsg: string;
	setCommitMsg: (msg: string) => void;
	actionPending: boolean;
	onPull: () => void;
	onPush: () => void;
	onCommit: () => void;
	onStageAll: () => void;
	onReloadStatus: () => void;
}

export function MobileGitChangesHeader({
	status,
	commitMsg,
	setCommitMsg,
	actionPending,
	onPull,
	onPush,
	onCommit,
	onStageAll,
	onReloadStatus,
}: Props) {
	const totalChanges = status.staged.length + status.unstaged.length;

	return (
		<View>
			{/* Sync & Remote Bar */}
			<View className="mb-3 rounded-2xl bg-card p-3.5">
				<View className="flex-row items-center justify-between">
					<View className="flex-1 flex-row items-center gap-2">
						<View className="h-2 w-2 rounded-full bg-ok" />
						<Text className="font-mono text-[13.5px] font-semibold text-ink" numberOfLines={1}>
							{status.branch}
						</Text>
					</View>
					<View className="flex-row items-center gap-2">
						<Pressable
							onPress={onPull}
							disabled={actionPending}
							className="rounded-full bg-elevated px-3 py-1 active:opacity-75"
						>
							<Text className="text-[11.5px] font-medium text-ink">
								拉取 {status.behind > 0 ? `(${status.behind})` : ""}
							</Text>
						</Pressable>
						<Pressable
							onPress={onPush}
							disabled={actionPending}
							className="rounded-full bg-accent/20 px-3 py-1 active:opacity-75"
						>
							<Text className="text-[11.5px] font-semibold text-accent">
								推送 {status.ahead > 0 ? `(${status.ahead})` : ""}
							</Text>
						</Pressable>
					</View>
				</View>

				{(status.ahead > 0 || status.behind > 0 || (status.unpushed ?? 0) > 0) && (
					<View className="mt-2 flex-row items-center gap-3 pt-2">
						{status.ahead > 0 && (
							<Text className="text-[11.5px] font-medium text-ok">领先 {status.ahead} 提交</Text>
						)}
						{status.behind > 0 && (
							<Text className="text-[11.5px] font-medium text-accent">落后 {status.behind} 提交</Text>
						)}
						{Boolean(status.unpushed) && (
							<Text className="text-[11.5px] text-ink-faint">未推送: {status.unpushed}</Text>
						)}
					</View>
				)}
			</View>

			{/* Commit Area */}
			<View className="mb-3 rounded-2xl bg-card p-3">
				<Text className="mb-1.5 text-[12px] font-semibold text-ink-muted">提交暂存区修改</Text>
				<TextInput
					value={commitMsg}
					onChangeText={setCommitMsg}
					placeholder="输入 Commit 提交信息…"
					placeholderTextColor="#666"
					className="mb-2.5 rounded-xl bg-input px-3 py-2 text-[13px] text-ink"
				/>
				<Pressable
					onPress={onCommit}
					disabled={actionPending || status.staged.length === 0 || !commitMsg.trim()}
					className={`items-center justify-center rounded-xl py-2 active:opacity-85 ${
						status.staged.length > 0 && commitMsg.trim() ? "bg-accent" : "bg-elevated opacity-60"
					}`}
				>
					<Text
						className={`text-[13px] font-semibold ${
							status.staged.length > 0 && commitMsg.trim() ? "text-white" : "text-ink-faint"
						}`}
					>
						提交 ({status.staged.length} 个暂存文件)
					</Text>
				</Pressable>
			</View>

			{/* File Changes Header */}
			<View className="mb-2 flex-row items-center justify-between px-1">
				<Text className="text-[13px] font-medium text-ink-muted">
					文件修改 ({totalChanges})
				</Text>
				<View className="flex-row items-center gap-3">
					{status.unstaged.length > 0 && (
						<Pressable onPress={onStageAll}>
							<Text className="text-[12px] font-medium text-accent">全部暂存</Text>
						</Pressable>
					)}
					<Pressable onPress={onReloadStatus}>
						<Text className="text-[12px] font-medium text-ink-muted">刷新</Text>
					</Pressable>
				</View>
			</View>

			{totalChanges === 0 && (
				<View className="items-center rounded-2xl bg-card p-8">
					<Text className="text-[13px] text-ink-faint">工作区干净，无未提交修改</Text>
				</View>
			)}
		</View>
	);
}
