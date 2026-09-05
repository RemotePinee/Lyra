import React from "react";
import { Pressable, Text, View } from "react-native";
import type { Message, TodoItem } from "./protocol";

export function MobileResumeRow({
	running,
	messages,
	todos,
	onResume,
}: {
	running: boolean;
	messages: Message[];
	todos: TodoItem[];
	onResume: (prompt: string) => void;
}) {
	if (running) return null;

	const unfinished = todos.filter((todo) => todo.status !== "completed").length;
	const last = messages[messages.length - 1];

	// Determine stop condition
	const isStoppedError = last?.role === "assistant" && last.stopReason === "error";
	const isStoppedAborted = last?.role === "assistant" && last.stopReason === "aborted";

	if (!isStoppedError && !isStoppedAborted && unfinished === 0) return null;

	const note = isStoppedError
		? "上次请求失败，进度已保留"
		: isStoppedAborted
			? "已暂停"
			: `计划还有 ${unfinished} 项未完成`;

	const prompt = isStoppedError || isStoppedAborted
		? "从中断的地方接着做。"
		: "继续，把计划剩下的部分做完。";

	return (
		<View className="mb-2.5 flex-row items-center justify-between rounded-xl border border-line-soft/30 bg-card/40 px-3.5 py-2">
			<View className="flex-1 flex-row items-center gap-2">
				<View className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
				<Text className="text-[12px] text-ink-muted" numberOfLines={1}>
					{note}
				</Text>
			</View>
			<Pressable
				onPress={() => onResume(prompt)}
				className="rounded-lg bg-card px-2.5 py-1 active:bg-card-hover"
			>
				<Text className="text-[11.5px] font-semibold text-accent">继续</Text>
			</Pressable>
		</View>
	);
}
