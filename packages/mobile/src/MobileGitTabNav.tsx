import { Pressable, Text, View } from "react-native";

export type GitTab = "changes" | "history" | "branches";

interface Props {
	activeTab: GitTab;
	totalChanges: number;
	onSelectTab: (tab: GitTab) => void;
}

export function MobileGitTabNav({
	activeTab,
	totalChanges,
	onSelectTab,
}: Props) {
	return (
		<View className="pb-3 pt-0.5">
			<View className="flex-row rounded-2xl bg-card p-1">
				<Pressable
					onPress={() => onSelectTab("changes")}
					className={`flex-1 items-center justify-center rounded-xl py-1.5 ${
						activeTab === "changes" ? "bg-elevated shadow-sm" : ""
					}`}
				>
					<Text
						className={`text-[12.5px] font-semibold ${
							activeTab === "changes" ? "text-accent" : "text-ink-muted"
						}`}
					>
						变更 {totalChanges > 0 ? `(${totalChanges})` : ""}
					</Text>
				</Pressable>
				<Pressable
					onPress={() => {
						onSelectTab("history");
					}}
					className={`flex-1 items-center justify-center rounded-xl py-1.5 ${
						activeTab === "history" ? "bg-elevated shadow-sm" : ""
					}`}
				>
					<Text
						className={`text-[12.5px] font-semibold ${
							activeTab === "history" ? "text-accent" : "text-ink-muted"
						}`}
					>
						历史
					</Text>
				</Pressable>
				<Pressable
					onPress={() => {
						onSelectTab("branches");
					}}
					className={`flex-1 items-center justify-center rounded-xl py-1.5 ${
						activeTab === "branches" ? "bg-elevated shadow-sm" : ""
					}`}
				>
					<Text
						className={`text-[12.5px] font-semibold ${
							activeTab === "branches" ? "text-accent" : "text-ink-muted"
						}`}
					>
						分支
					</Text>
				</Pressable>
			</View>
		</View>
	);
}
