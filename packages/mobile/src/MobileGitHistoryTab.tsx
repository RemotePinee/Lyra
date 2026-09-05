import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { GitCommit } from "./protocol";

interface Props {
	commits: GitCommit[];
	hasLoadedHistory: boolean;
	onReloadHistory: () => Promise<void>;
}

export function MobileGitHistoryTab({ commits, hasLoadedHistory, onReloadHistory }: Props) {
	return (
		<ScrollView className="flex-1 pt-1" showsVerticalScrollIndicator={false}>
			<View className="mb-2 flex-row items-center justify-between px-1">
				<Text className="text-[13px] font-medium text-ink-muted">
					提交历史 ({commits.length})
				</Text>
				<Pressable onPress={() => void onReloadHistory()}>
					<Text className="text-[12px] font-medium text-ink-muted">刷新</Text>
				</Pressable>
			</View>

			{!hasLoadedHistory ? (
				<View className="items-center py-12">
					<ActivityIndicator size="small" />
				</View>
			) : commits.length === 0 ? (
				<View className="items-center rounded-2xl bg-card p-8">
					<Text className="text-[13px] text-ink-faint">暂无提交历史记录</Text>
				</View>
			) : (
				<View className="mb-8 overflow-hidden rounded-2xl bg-card">
					{commits.map((c, idx) => (
						<View
							key={c.hash || idx}
							className="p-3"
						>
							<View className="flex-row items-center justify-between">
								<Text className="font-mono text-[11.5px] font-semibold text-accent">
									{c.shortHash}
								</Text>
								<Text className="text-[11px] text-ink-faint">
									{c.relativeDate}
								</Text>
							</View>
							<Text className="mt-1 text-[13px] font-medium text-ink">
								{c.subject}
							</Text>
							<Text className="mt-0.5 text-[11px] text-ink-muted">
								{c.author}
							</Text>
						</View>
					))}
				</View>
			)}
		</ScrollView>
	);
}
