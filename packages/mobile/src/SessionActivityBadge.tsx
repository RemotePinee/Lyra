import React, { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withRepeat,
	withSequence,
	withTiming,
} from "react-native-reanimated";

interface SessionActivityBadgeProps {
	activity?: "running" | "waiting" | "done" | "failed" | null;
}

export function SessionActivityBadge({ activity }: SessionActivityBadgeProps) {
	const pulseAnim = useSharedValue(1);

	useEffect(() => {
		if (activity === "running" || activity === "waiting") {
			pulseAnim.value = withRepeat(
				withSequence(
					withTiming(0.4, { duration: 750 }),
					withTiming(1, { duration: 750 }),
				),
				-1,
				true,
			);
		} else {
			pulseAnim.value = 1;
		}
	}, [activity, pulseAnim]);

	const animatedDotStyle = useAnimatedStyle(() => ({
		opacity: pulseAnim.value,
		transform: [{ scale: 0.85 + pulseAnim.value * 0.15 }],
	}));

	if (!activity) return null;

	if (activity === "running") {
		return (
			<View className="flex-row items-center gap-1.5 rounded-full bg-accent/15 px-2 py-0.5">
				<Animated.View
					style={animatedDotStyle}
					className="h-2 w-2 rounded-full bg-accent"
				/>
				<Text className="text-[11px] font-medium text-accent">执行中</Text>
			</View>
		);
	}

	if (activity === "waiting") {
		return (
			<View className="flex-row items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5">
				<Animated.View
					style={animatedDotStyle}
					className="h-2 w-2 rounded-full bg-amber-500"
				/>
				<Text className="text-[11px] font-medium text-amber-500">待批准</Text>
			</View>
		);
	}

	if (activity === "done") {
		return (
			<View className="flex-row items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5">
				<View className="h-2 w-2 rounded-full bg-emerald-500" />
				<Text className="text-[11px] font-medium text-emerald-500">已完成</Text>
			</View>
		);
	}

	if (activity === "failed") {
		return (
			<View className="flex-row items-center gap-1.5 rounded-full bg-danger/15 px-2 py-0.5">
				<View className="h-2 w-2 rounded-full bg-danger" />
				<Text className="text-[11px] font-medium text-danger">失败</Text>
			</View>
		);
	}

	return null;
}
