import React, { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { MobileMarkdownView } from "./MarkdownContent";
import { useThemeColors } from "./theme";

export function MobileThinkingBlock({
	text,
	redacted,
	live,
	onCollapse,
}: {
	text: string;
	redacted?: boolean;
	live?: boolean;
	onCollapse?: (source: "top" | "bottom", heightDiff: number) => void;
}) {
	const [open, setOpen] = useState(false);
	const { colors } = useThemeColors();
	const containerHeightRef = useRef(0);
	const headerHeightRef = useRef(44);

	if (!text && !redacted) return null;

	const handleCollapse = (source: "top" | "bottom") => {
		const diff = Math.max(0, containerHeightRef.current - (headerHeightRef.current || 44));
		setOpen(false);
		onCollapse?.(source, diff);
	};

	const toggleOpen = () => {
		if (open) {
			handleCollapse("top");
		} else {
			setOpen(true);
		}
	};

	const isLong = text.trim().length > 80 || text.split("\n").length > 2;

	return (
		<View
			onLayout={(e) => {
				containerHeightRef.current = e.nativeEvent.layout.height;
			}}
			style={{ backgroundColor: colors.card }}
			className="mb-2.5 overflow-hidden rounded-2xl"
		>
			<Pressable
				disabled={redacted}
				onLayout={(e) => {
					headerHeightRef.current = e.nativeEvent.layout.height;
				}}
				onPress={toggleOpen}
				className="flex-row items-center justify-between px-3.5 py-2.5 active:opacity-80"
			>
				<View className="mr-2 flex-1 flex-row items-center gap-2">
					<View
						className={`h-2 w-2 rounded-full ${
							live ? "bg-accent" : "bg-ink-faint"
						}`}
					/>
					<Text
						style={{ color: colors.ink }}
						className="flex-1 text-[13px] font-medium"
						numberOfLines={1}
					>
						{redacted
							? "思考内容已被安全过滤"
							: live
								? "正在深度思考…"
								: "思考过程"}
					</Text>
				</View>
				{!redacted && (
					<View className="flex-row items-center gap-2">
						<Text style={{ color: colors.inkMuted }} className="text-[11.5px]">
							{open ? "收起" : "展开"}
						</Text>
						<Text style={{ color: colors.inkFaint }} className="text-[11px]">
							{open ? "▾" : "▸"}
						</Text>
					</View>
				)}
			</Pressable>

			{open && !redacted && (
				<View className="border-t border-line-soft/30 px-3.5 pb-2.5 pt-3">
					<MobileMarkdownView content={text} />
					{isLong && (
						<Pressable
							onPress={() => handleCollapse("bottom")}
							className="mt-2.5 flex-row items-center justify-center gap-1 rounded-xl bg-card-hover py-2 active:opacity-75"
						>
							<Text className="text-[11.5px] font-medium text-ink-muted">收起思考过程</Text>
							<Text className="text-[11px] text-ink-muted">▴</Text>
						</Pressable>
					)}
				</View>
			)}
		</View>
	);
}
