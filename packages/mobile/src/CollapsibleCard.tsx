import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";

export function MobileCollapsibleCodeCard({ title, content }: { title: string; content: string }) {
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const lines = content.split("\n");
	const lineCount = lines.length;
	const sizeKb = (new Blob([content]).size / 1024).toFixed(1);

	const handleCopy = async () => {
		await Clipboard.setStringAsync(content);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<View className="mb-1.5 max-w-[92%] overflow-hidden rounded-xl bg-card">
			<Pressable
				onPress={() => setExpanded((prev) => !prev)}
				className="flex-row items-center justify-between bg-card-hover px-3.5 py-2.5 active:opacity-80"
			>
				<View className="flex-row items-center gap-2">
					<View className="h-4.5 px-1.5 items-center justify-center rounded bg-accent/15">
						<Text style={{ fontSize: 9, fontWeight: "700", color: "#ff8b3d", letterSpacing: 0.5 }}>
							CODE
						</Text>
					</View>
					<Text className="text-[12.5px] font-medium text-ink">{title}</Text>
					<Text className="text-[11px] text-ink-faint">
						{lineCount} 行 · {sizeKb} KB
					</Text>
				</View>
				<View className="flex-row items-center gap-2">
					<Pressable onPress={handleCopy} className="rounded bg-elevated px-2 py-1 active:opacity-60">
						<Text className="text-[11px] font-medium text-ink-muted">{copied ? "已复制" : "复制"}</Text>
					</Pressable>
					<Text className="text-[11px] text-ink-faint">{expanded ? "收起" : "展开"}</Text>
				</View>
			</Pressable>

			{expanded ? (
				<ScrollView className="max-h-72 bg-card px-3.5 py-3" nestedScrollEnabled>
					<Text className="font-mono text-[11.5px] leading-5 text-ink-muted" selectable>
						{content}
					</Text>
				</ScrollView>
			) : (
				<Pressable onPress={() => setExpanded(true)} className="bg-card px-3.5 py-2.5 active:bg-card-hover">
					<Text className="font-mono text-[11px] leading-4 text-ink-muted" numberOfLines={2}>
						{lines.slice(0, 2).join("\n")}
					</Text>
				</Pressable>
			)}
		</View>
	);
}
