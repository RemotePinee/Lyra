import React, { useEffect, useRef } from "react";
import {
	Animated,
	Pressable,
	StyleSheet,
	Text,
	TouchableWithoutFeedback,
	View,
} from "react-native";
import { haptic } from "./haptics";
import { useThemeColors } from "./theme";

export interface SheetAction {
	label: string;
	onPress: () => void;
	destructive?: boolean;
	icon?: React.ReactNode;
	description?: string;
}

interface MobileActionSheetProps {
	visible: boolean;
	title?: string;
	message?: string;
	iconKind?: "chat" | "image" | "file" | "git" | "default";
	headerIcon?: React.ReactNode;
	actions: SheetAction[];
	onClose: () => void;
}

/**
 * Clean floating card modal without React Native <Modal> window grab:
 * - Rendered as pure absolute overlay in current window hierarchy
 * - Keeps software keyboard UP without dismiss or focus theft
 * - Micro-spring scale & fade animation via native driver (0ms jank)
 */
export function MobileActionSheet({
	visible,
	title,
	actions,
	onClose,
}: MobileActionSheetProps) {
	const { colors, isDark } = useThemeColors();
	const animScale = useRef(new Animated.Value(0.92)).current;
	const animOpacity = useRef(new Animated.Value(0)).current;

	useEffect(() => {
		if (visible) {
			animScale.setValue(0.92);
			animOpacity.setValue(0);
			Animated.parallel([
				Animated.spring(animScale, {
					toValue: 1,
					tension: 300,
					friction: 24,
					useNativeDriver: true,
				}),
				Animated.timing(animOpacity, {
					toValue: 1,
					duration: 160,
					useNativeDriver: true,
				}),
			]).start();
		}
	}, [visible, animScale, animOpacity]);

	if (!visible) return null;

	const handleClose = () => {
		haptic.tap();
		Animated.parallel([
			Animated.timing(animScale, {
				toValue: 0.94,
				duration: 120,
				useNativeDriver: true,
			}),
			Animated.timing(animOpacity, {
				toValue: 0,
				duration: 120,
				useNativeDriver: true,
			}),
		]).start(() => {
			onClose();
		});
	};

	return (
		<View
			style={[StyleSheet.absoluteFill, { zIndex: 9999 }]}
			pointerEvents="box-none"
		>
			{/* Completely Transparent Outside Tap Area (NO dark veil) */}
			<TouchableWithoutFeedback onPress={handleClose}>
				<View style={StyleSheet.absoluteFill} />
			</TouchableWithoutFeedback>

			{/* Floating Card with subtle float elevation */}
			<View className="flex-1 items-center justify-center px-6" pointerEvents="box-none">
				<TouchableWithoutFeedback>
					<Animated.View
						style={{
							transform: [{ scale: animScale }],
							opacity: animOpacity,
							backgroundColor: colors.card,
							shadowColor: "#000",
							shadowOffset: { width: 0, height: 12 },
							shadowOpacity: isDark ? 0.45 : 0.16,
							shadowRadius: 28,
							elevation: 20,
						}}
						className="w-full max-w-[310px] overflow-hidden rounded-[24px] p-4"
					>
						{/* Minimal Header */}
						<View
							style={{
								flexDirection: "row",
								alignItems: "center",
								justifyContent: "space-between",
								marginBottom: 12,
								paddingLeft: 14,
								paddingRight: 12,
							}}
						>
							<Text
								style={{ color: colors.ink, fontSize: 15, fontWeight: "700", letterSpacing: -0.2 }}
								numberOfLines={1}
							>
								{title || "操作"}
							</Text>

							<Pressable
								onPress={handleClose}
								hitSlop={8}
							>
								<View
									style={{
										width: 24,
										height: 24,
										borderRadius: 12,
										backgroundColor: isDark ? "#4b4c52" : "#d1d1d6",
										alignItems: "center",
										justifyContent: "center",
									}}
								>
									<Text
										style={{
											color: isDark ? "#ffffff" : "#000000",
											fontSize: 12,
											fontWeight: "800",
											includeFontPadding: false,
											textAlign: "center",
										}}
									>
										✕
									</Text>
								</View>
							</Pressable>
						</View>

						{/* Actions Rows */}
						<View className="gap-1.5">
							{actions.map((action) => (
								<Pressable
									key={action.label}
									onPress={() => {
										if (action.destructive) {
											haptic.heavy();
										} else {
											haptic.impact();
										}
										onClose();
										action.onPress();
									}}
									style={({ pressed }) => [
										{
											backgroundColor: pressed
												? colors.cardHover
												: action.destructive
												? colors.danger + "15"
												: colors.panel,
										},
									]}
									className="flex-row items-center justify-between rounded-xl px-4 py-3 active:opacity-85"
								>
									<View className="flex-row items-center gap-2.5">
										{action.icon && (
											<View className="items-center justify-center">
												{action.icon}
											</View>
										)}
										<Text
											style={{
												color: action.destructive ? colors.danger : colors.ink,
												fontSize: 14.5,
												fontWeight: action.destructive ? "600" : "500",
											}}
										>
											{action.label}
										</Text>
									</View>

									<View style={{ width: 16, alignItems: "center", justifyContent: "center" }}>
										<Text
											style={{
												color: action.destructive ? colors.danger : colors.inkFaint,
												fontSize: 14,
												fontWeight: "500",
												includeFontPadding: false,
											}}
										>
											›
										</Text>
									</View>
								</Pressable>
							))}
						</View>
					</Animated.View>
				</TouchableWithoutFeedback>
			</View>
		</View>
	);
}

interface MobileConfirmDialogProps {
	visible: boolean;
	title: string;
	message?: string;
	confirmText?: string;
	cancelText?: string;
	destructive?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

/**
 * Clean floating confirm card without React Native <Modal> window grab:
 * - Pure absolute overlay inside screen hierarchy
 * - Keeps keyboard position steady
 */
export function MobileConfirmDialog({
	visible,
	title,
	message,
	confirmText = "确定",
	cancelText = "取消",
	destructive = false,
	onConfirm,
	onCancel,
}: MobileConfirmDialogProps) {
	const { colors, isDark } = useThemeColors();
	const animScale = useRef(new Animated.Value(0.92)).current;
	const animOpacity = useRef(new Animated.Value(0)).current;

	useEffect(() => {
		if (visible) {
			animScale.setValue(0.92);
			animOpacity.setValue(0);
			Animated.parallel([
				Animated.spring(animScale, {
					toValue: 1,
					tension: 300,
					friction: 24,
					useNativeDriver: true,
				}),
				Animated.timing(animOpacity, {
					toValue: 1,
					duration: 160,
					useNativeDriver: true,
				}),
			]).start();
		}
	}, [visible, animScale, animOpacity]);

	if (!visible) return null;

	const handleClose = () => {
		haptic.tap();
		Animated.parallel([
			Animated.timing(animScale, {
				toValue: 0.94,
				duration: 120,
				useNativeDriver: true,
			}),
			Animated.timing(animOpacity, {
				toValue: 0,
				duration: 120,
				useNativeDriver: true,
			}),
		]).start(() => {
			onCancel();
		});
	};

	return (
		<View
			style={[StyleSheet.absoluteFill, { zIndex: 9999 }]}
			pointerEvents="box-none"
		>
			{/* Completely Transparent Outside Tap Area (NO dark veil) */}
			<TouchableWithoutFeedback onPress={handleClose}>
				<View style={StyleSheet.absoluteFill} />
			</TouchableWithoutFeedback>

			<View className="flex-1 items-center justify-center px-6" pointerEvents="box-none">
				<TouchableWithoutFeedback>
					<Animated.View
						style={{
							transform: [{ scale: animScale }],
							opacity: animOpacity,
							backgroundColor: colors.card,
							shadowColor: "#000",
							shadowOffset: { width: 0, height: 12 },
							shadowOpacity: isDark ? 0.45 : 0.16,
							shadowRadius: 28,
							elevation: 20,
						}}
						className="w-full max-w-[305px] overflow-hidden rounded-[24px] p-4"
					>
						<Text
							style={{ color: colors.ink, fontSize: 16, fontWeight: "700", letterSpacing: -0.2 }}
							className="text-left px-1"
						>
							{title}
						</Text>
						{Boolean(message) && (
							<Text
								style={{ color: colors.inkMuted, fontSize: 13 }}
								className="mt-2 text-left leading-5 px-1"
							>
								{message}
							</Text>
						)}

						<View className="mt-4 flex-row items-center justify-end gap-2 px-1">
							{Boolean(cancelText) && (
								<Pressable
									onPress={handleClose}
									style={({ pressed }) => [
										{
											backgroundColor: pressed
												? colors.cardHover
												: colors.elevated,
										},
									]}
									className="rounded-xl px-3.5 py-2 active:opacity-75"
								>
									<Text
										style={{ color: colors.inkMuted, fontSize: 13, fontWeight: "600" }}
									>
										{cancelText}
									</Text>
								</Pressable>
							)}

							<Pressable
								onPress={() => {
									if (destructive) {
										haptic.heavy();
									} else {
										haptic.impact();
									}
									onCancel();
									onConfirm();
								}}
								style={({ pressed }) => [
									{
										backgroundColor: pressed
											? colors.cardHover
											: destructive
											? colors.danger
											: colors.ink,
									},
								]}
								className="rounded-xl px-3.5 py-2 active:opacity-85"
							>
								<Text
									style={{
										color: destructive ? "#ffffff" : colors.shell,
										fontSize: 13,
										fontWeight: "600",
									}}
								>
									{confirmText}
								</Text>
							</Pressable>
						</View>
					</Animated.View>
				</TouchableWithoutFeedback>
			</View>
		</View>
	);
}
