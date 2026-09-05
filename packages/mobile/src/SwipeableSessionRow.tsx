import React from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { RectButton } from "react-native-gesture-handler";
import Swipeable from "react-native-gesture-handler/Swipeable";
import { haptic } from "./haptics";
import type { SessionMeta } from "./protocol";

interface SwipeableSessionRowProps {
	session: SessionMeta;
	children: React.ReactNode;
	onArchive: (session: SessionMeta) => void;
	onDelete: (session: SessionMeta) => void;
	onOpen?: () => void;
	openRowRef?: React.MutableRefObject<Swipeable | null>;
}

export function SwipeableSessionRow({
	session,
	children,
	onArchive,
	onDelete,
	onOpen,
	openRowRef,
}: SwipeableSessionRowProps) {
	const swipeableRef = React.useRef<Swipeable>(null);
	const renderRightActions = (
		progress: Animated.AnimatedInterpolation<number>,
		_dragX: Animated.AnimatedInterpolation<number>,
	) => {
		const transArchive = progress.interpolate({
			inputRange: [0, 1],
			outputRange: [148, 0],
			extrapolate: "clamp",
		});

		const transDelete = progress.interpolate({
			inputRange: [0, 1],
			outputRange: [74, 0],
			extrapolate: "clamp",
		});

		const opacity = progress.interpolate({
			inputRange: [0, 0.4, 1],
			outputRange: [0, 0.7, 1],
		});

		return (
			<View className="w-[152px] flex-row items-center pl-2 my-0.5 gap-1.5">
				{/* 归档 / 恢复按钮 */}
				<Animated.View
					style={{
						transform: [{ translateX: transArchive }],
						opacity,
						flex: 1,
						height: "100%",
					}}
					className="overflow-hidden rounded-2xl"
				>
					<RectButton
						onPress={() => {
							haptic.impact();
							onArchive(session);
						}}
						style={[
							StyleSheet.absoluteFill,
							{
								backgroundColor: session.archived ? "#10b981" : "#f59e0b",
								alignItems: "center",
								justifyContent: "center",
							},
						]}
					>
						<Text className="text-[13px] font-bold text-white tracking-wider">
							{session.archived ? "恢复" : "归档"}
						</Text>
					</RectButton>
				</Animated.View>

				{/* 彻底删除按钮 */}
				<Animated.View
					style={{
						transform: [{ translateX: transDelete }],
						opacity,
						flex: 1,
						height: "100%",
					}}
					className="overflow-hidden rounded-2xl"
				>
					<RectButton
						onPress={() => {
							haptic.heavy();
							onDelete(session);
						}}
						style={[
							StyleSheet.absoluteFill,
							{
								backgroundColor: "#ef4444",
								alignItems: "center",
								justifyContent: "center",
							},
						]}
					>
						<Text className="text-[13px] font-bold text-white tracking-wider">
							删除
						</Text>
					</RectButton>
				</Animated.View>
			</View>
		);
	};

	return (
		<Swipeable
			ref={swipeableRef}
			renderRightActions={renderRightActions}
			friction={2}
			overshootRight={false}
			rightThreshold={40}
			onSwipeableWillOpen={() => {
				haptic.tap();
				if (openRowRef && openRowRef.current && openRowRef.current !== swipeableRef.current) {
					openRowRef.current.close();
				}
				if (openRowRef) {
					openRowRef.current = swipeableRef.current;
				}
				onOpen?.();
			}}
		>
			{children}
		</Swipeable>
	);
}
