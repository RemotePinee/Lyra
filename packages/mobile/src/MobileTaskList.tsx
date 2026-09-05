import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TodoItem } from "./protocol";
import { useThemeColors } from "./theme";

export function MobileTaskList({
	todos,
	running,
	onPause,
	onResume,
}: {
	todos: TodoItem[];
	running: boolean;
	onPause?: () => void;
	onResume?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const { colors } = useThemeColors();

	if (todos.length === 0) return null;

	const active = todos.find((t) => t.status === "in_progress");
	const doneCount = todos.filter((t) => t.status === "completed").length;
	const total = todos.length;

	// Desktop design principle: "A finished plan puts itself away"
	// Once all steps are completed (done === total), automatically hide the floating bar
	if (doneCount === total) return null;

	return (
		<View className="overflow-hidden">
			{/* Top Bar / Summary Line: Pure minimal text line, zero container background */}
			<Pressable
				onPress={() => setOpen((v) => !v)}
				className="flex-row items-center justify-between py-1.5 active:opacity-75"
			>
				<View className="mr-2 flex-1 flex-row items-center gap-2">
					<View
						className={`h-2 w-2 rounded-full ${
							running ? "bg-accent" : "bg-ink-faint"
						}`}
					/>
					<Text
						style={{ color: colors.ink }}
						className="flex-1 text-[13px] font-medium"
						numberOfLines={1}
					>
						{active?.activeForm || active?.content || "任务清单"}
					</Text>
				</View>

				<View className="flex-row items-center gap-2">
					<Text style={{ color: colors.inkMuted }} className="text-[11.5px] font-mono">
						{doneCount}/{total}
					</Text>
					{/* Action toggle button: pause or resume */}
					{running ? (
						onPause && (
							<Pressable
								onPress={(e) => {
									e.stopPropagation();
									onPause();
								}}
								style={{ backgroundColor: colors.elevated }}
								className="rounded-lg px-2.5 py-1 active:opacity-75"
							>
								<Text style={{ color: colors.ink }} className="text-[11px] font-medium">暂停</Text>
							</Pressable>
						)
					) : (
						doneCount < total &&
						onResume && (
							<Pressable
								onPress={(e) => {
									e.stopPropagation();
									onResume();
								}}
								style={{ backgroundColor: colors.accent }}
								className="rounded-lg px-2.5 py-1 active:opacity-75"
							>
								<Text className="text-[11px] font-medium text-white">继续</Text>
							</Pressable>
						)
					)}
					<Text style={{ color: colors.inkFaint }} className="text-[11px]">{open ? "▾" : "▸"}</Text>
				</View>
			</Pressable>

			{/* Unfolded Items List: Floating rounded list when expanded */}
			{open && (
				<View
					style={{ backgroundColor: colors.card }}
					className="mt-1.5 rounded-2xl p-3 shadow-md"
				>
					{todos.map((item, idx) => {
						const isDone = item.status === "completed";
						const isInProgress = item.status === "in_progress";
						return (
							<View key={idx} className="flex-row items-center gap-2.5 py-1.5">
								<View
									className={`h-3.5 w-3.5 items-center justify-center rounded-[4px] border ${
										isDone
											? "border-ok bg-ok/20"
											: isInProgress
												? "border-accent bg-accent/20"
												: "border-ink-faint/30"
									}`}
								>
									{isDone && <Text className="text-[9px] text-ok">✓</Text>}
									{isInProgress && <View className="h-1.5 w-1.5 rounded-full bg-accent" />}
								</View>
								<Text
									style={{
										color: isDone ? colors.inkFaint : isInProgress ? colors.ink : colors.inkMuted,
									}}
									className={`flex-1 text-[12.5px] leading-5 ${
										isDone ? "line-through" : isInProgress ? "font-medium" : ""
									}`}
								>
									{item.content}
								</Text>
							</View>
						);
					})}
				</View>
			)}
		</View>
	);
}
