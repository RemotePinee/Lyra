import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import type { SyncClient } from "./client";
import type { BranchList } from "./protocol";

interface Props {
	currentBranch: string;
	branchList: BranchList | null;
	hasLoadedBranches: boolean;
	cwd?: string;
	client: SyncClient | null;
	actionPending: boolean;
	setActionPending: (pending: boolean) => void;
	onReloadBranches: () => Promise<void>;
	onReloadStatus: () => Promise<void>;
	onReloadHistory: () => Promise<void>;
}

export function MobileGitBranchesTab({
	currentBranch,
	branchList,
	hasLoadedBranches,
	cwd,
	client,
	actionPending,
	setActionPending,
	onReloadBranches,
	onReloadStatus,
	onReloadHistory,
}: Props) {
	const allBranches = [
		...(branchList?.local ?? []),
		...(branchList?.remote ?? []),
	];

	const handleSwitchBranch = (branch: string) => {
		if (!client || !cwd || actionPending || branch === currentBranch) return;
		Alert.alert(
			"切换分支",
			`确定要切换至分支 "${branch}" 吗？`,
			[
				{ text: "取消", style: "cancel" },
				{
					text: "切换",
					onPress: async () => {
						setActionPending(true);
						try {
							const res = await client.gitSwitch(cwd, branch);
							if (!res.ok) Alert.alert("切换失败", res.error || "未知错误");
							else {
								await onReloadStatus();
								await onReloadBranches();
								void onReloadHistory();
							}
						} finally {
							setActionPending(false);
						}
					},
				},
			],
		);
	};

	return (
		<ScrollView className="flex-1 pt-1" showsVerticalScrollIndicator={false}>
			<View className="mb-2 flex-row items-center justify-between px-1">
				<Text className="text-[13px] font-medium text-ink-muted">
					分支列表 ({allBranches.length})
				</Text>
				<Pressable onPress={() => void onReloadBranches()}>
					<Text className="text-[12px] font-medium text-ink-muted">刷新</Text>
				</Pressable>
			</View>

			{!hasLoadedBranches ? (
				<View className="items-center py-12">
					<ActivityIndicator size="small" />
				</View>
			) : allBranches.length === 0 ? (
				<View className="items-center rounded-2xl bg-card p-8">
					<Text className="text-[13px] text-ink-faint">未找到分支</Text>
				</View>
			) : (
				<View className="mb-8 overflow-hidden rounded-2xl bg-card">
					{allBranches.map((name) => {
						const isCurrent = name === currentBranch;
						return (
							<Pressable
								key={name}
								onPress={() => handleSwitchBranch(name)}
								className="flex-row items-center justify-between p-3 active:bg-card-hover"
							>
								<View className="flex-1 flex-row items-center gap-2.5">
									<View
										className={`h-2 w-2 rounded-full ${
											isCurrent ? "bg-ok" : "bg-transparent"
										}`}
									/>
									<Text
										className={`font-mono text-[13px] ${
											isCurrent ? "font-bold text-ink" : "text-ink-muted"
										}`}
									>
										{name}
									</Text>
								</View>
								{isCurrent ? (
									<Text className="text-[11.5px] font-medium text-ok">当前分支</Text>
								) : (
									<Text className="text-[11.5px] font-medium text-accent">切换</Text>
								)}
							</Pressable>
						);
					})}
				</View>
			)}
		</ScrollView>
	);
}
