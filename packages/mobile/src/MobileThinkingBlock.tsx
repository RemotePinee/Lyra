import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { MobileMarkdownView } from "./MarkdownContent";

export function MobileThinkingBlock({
	text,
	redacted,
	live,
}: {
	text: string;
	redacted?: boolean;
	live?: boolean;
}) {
	const [open, setOpen] = useState(false);

	if (!text && !redacted) return null;

	return (
		<View className="mb-2.5 overflow-hidden rounded-2xl border border-line-soft/40 bg-card/40">
			<Pressable
				disabled={redacted}
				onPress={() => setOpen((v) => !v)}
				className="flex-row items-center justify-between px-3.5 py-2.5 active:bg-card-hover"
			>
				<View className="mr-2 flex-1 flex-row items-center gap-2">
					<View
						className={`h-2 w-2 rounded-full ${
							live ? "bg-accent" : "bg-ink-faint"
						}`}
					/>
					<Text className="flex-1 text-[12.5px] font-medium text-ink-muted" numberOfLines={1}>
						{redacted
							? "思考内容已被安全过滤"
							: live
								? "正在深度思考…"
								: "思考过程"}
					</Text>
				</View>
				{!redacted && (
					<View className="flex-row items-center gap-1.5">
						<Text className="text-[11px] text-ink-faint">{open ? "收起" : "展开"}</Text>
						<Text className="text-[11px] text-ink-faint">{open ? "▾" : "▸"}</Text>
					</View>
				)}
			</Pressable>

			{open && !redacted && (
				<View className="border-t border-line-soft/30 bg-card/60 px-3.5 py-3">
					<MobileMarkdownView content={text} />
				</View>
			)}
		</View>
	);
}
