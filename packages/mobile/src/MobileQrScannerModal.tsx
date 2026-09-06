import { BarcodeScanningResult, CameraView } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import {
	Dimensions,
	Modal,
	Pressable,
	StatusBar,
	StyleSheet,
	Text,
	View,
} from "react-native";
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withRepeat,
	withSequence,
	withSpring,
	withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "./haptics";

interface MobileQrScannerModalProps {
	visible: boolean;
	title?: string;
	onClose: () => void;
	onScanned: (data: string) => Promise<boolean | void> | boolean | void;
}

// Google Iconic Colors
const C_BLUE = "#4285F4";
const C_YELLOW = "#FBBC05";
const C_GREEN = "#34A853";
const C_RED = "#EA4335";

export function MobileQrScannerModal({
	visible,
	title = "扫描二维码",
	onClose,
	onScanned,
}: MobileQrScannerModalProps) {
	const insets = useSafeAreaInsets();
	const [scanned, setScanned] = useState(false);
	const [lockedTarget, setLockedTarget] = useState(false);
	const [torch, setTorch] = useState(false);
	const isProcessingRef = useRef(false);

	const windowDim = Dimensions.get("window");
	const screenWidth = windowDim.width;
	const screenHeight = windowDim.height;

	// Viewfinder frame dimensions
	const defaultBoxSize = Math.min(screenWidth * 0.72, 280);
	const defaultBoxLeft = (screenWidth - defaultBoxSize) / 2;
	const defaultBoxTop = (screenHeight - defaultBoxSize) / 2 - 25;

	// Animated Spring Tracking
	const boxX = useSharedValue(defaultBoxLeft);
	const boxY = useSharedValue(defaultBoxTop);
	const boxWidth = useSharedValue(defaultBoxSize);
	const boxHeight = useSharedValue(defaultBoxSize);
	const lockPulse = useSharedValue(1);
	const scanLineY = useSharedValue(0);

	useEffect(() => {
		if (visible) {
			setScanned(false);
			setLockedTarget(false);
			setTorch(false);
			isProcessingRef.current = false;
			boxX.value = defaultBoxLeft;
			boxY.value = defaultBoxTop;
			boxWidth.value = defaultBoxSize;
			boxHeight.value = defaultBoxSize;
			lockPulse.value = 1;

			scanLineY.value = 0;
			scanLineY.value = withRepeat(
				withSequence(
					withTiming(defaultBoxSize - 20, { duration: 1700 }),
					withTiming(0, { duration: 1700 }),
				),
				-1,
				true,
			);
		}
	}, [visible, defaultBoxLeft, defaultBoxTop, defaultBoxSize, boxHeight, boxWidth, boxX, boxY, scanLineY, lockPulse]);

	const handleBarcodeScanned = async (result: BarcodeScanningResult) => {
		if (scanned || isProcessingRef.current) return;

		const { data, bounds } = result;

		// 1. Viewfinder zone constraint (only trigger inside target frame)
		const zoneLeft = defaultBoxLeft - 40;
		const zoneTop = defaultBoxTop - 40;
		const zoneRight = defaultBoxLeft + defaultBoxSize + 40;
		const zoneBottom = defaultBoxTop + defaultBoxSize + 40;

		if (bounds && bounds.origin && bounds.size) {
			const centerX = bounds.origin.x + bounds.size.width / 2;
			const centerY = bounds.origin.y + bounds.size.height / 2;

			if (centerX < zoneLeft || centerX > zoneRight || centerY < zoneTop || centerY > zoneBottom) {
				return;
			}

			// 2. Smooth spring-lock animation to code bounds
			const pad = 14;
			const targetX = Math.max(16, bounds.origin.x - pad);
			const targetY = Math.max(40, bounds.origin.y - pad);
			const targetW = bounds.size.width + pad * 2;
			const targetH = bounds.size.height + pad * 2;

			boxX.value = withSpring(targetX, { damping: 22, stiffness: 210 });
			boxY.value = withSpring(targetY, { damping: 22, stiffness: 210 });
			boxWidth.value = withSpring(targetW, { damping: 22, stiffness: 210 });
			boxHeight.value = withSpring(targetH, { damping: 22, stiffness: 210 });
			lockPulse.value = withSequence(
				withTiming(1.04, { duration: 90 }),
				withTiming(1, { duration: 90 }),
			);
		}

		isProcessingRef.current = true;
		setLockedTarget(true);
		haptic.heavy();

		setTimeout(async () => {
			setScanned(true);
			await onScanned(data);
			isProcessingRef.current = false;
		}, 280);
	};

	const trackingBoxStyle = useAnimatedStyle(() => ({
		position: "absolute",
		left: boxX.value,
		top: boxY.value,
		width: boxWidth.value,
		height: boxHeight.value,
		transform: [{ scale: lockPulse.value }],
	}));

	const scanLineStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: scanLineY.value }],
	}));

	// Precision Google-style Corner Settings:
	// Thick, smooth rounded corners without outer square artefacts
	const armLen = 42;
	const thick = 5;
	const radius = 22;

	return (
		<Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onClose}>
			<StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
			<View className="flex-1 bg-black">
				<CameraView
					style={StyleSheet.absoluteFill}
					facing="back"
					enableTorch={torch}
					barcodeScannerSettings={{
						barcodeTypes: ["qr"],
					}}
					onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
				/>

				{/* Google-like subtle background mask */}
				<View style={StyleSheet.absoluteFill} className="bg-black/45" pointerEvents="none" />

				{/* Dynamic Google Reticle Frame */}
				<Animated.View
					style={[
						trackingBoxStyle,
						{
							backgroundColor: lockedTarget ? "rgba(52, 168, 83, 0.12)" : "transparent",
						},
					]}
					pointerEvents="none"
				>
					{/* Top-Left: Google Blue */}
					<View
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: armLen,
							height: armLen,
							borderTopWidth: thick,
							borderLeftWidth: thick,
							borderColor: lockedTarget ? C_GREEN : C_BLUE,
							borderTopLeftRadius: radius,
						}}
					/>

					{/* Top-Right: Google Yellow */}
					<View
						style={{
							position: "absolute",
							top: 0,
							right: 0,
							width: armLen,
							height: armLen,
							borderTopWidth: thick,
							borderRightWidth: thick,
							borderColor: lockedTarget ? C_GREEN : C_YELLOW,
							borderTopRightRadius: radius,
						}}
					/>

					{/* Bottom-Left: Google Green */}
					<View
						style={{
							position: "absolute",
							bottom: 0,
							left: 0,
							width: armLen,
							height: armLen,
							borderBottomWidth: thick,
							borderLeftWidth: thick,
							borderColor: C_GREEN,
							borderBottomLeftRadius: radius,
						}}
					/>

					{/* Bottom-Right: Google Red */}
					<View
						style={{
							position: "absolute",
							bottom: 0,
							right: 0,
							width: armLen,
							height: armLen,
							borderBottomWidth: thick,
							borderRightWidth: thick,
							borderColor: lockedTarget ? C_GREEN : C_RED,
							borderBottomRightRadius: radius,
						}}
					/>

					{/* Scanning subtle light bar */}
					{!lockedTarget && (
						<View style={{ flex: 1, overflow: "hidden", margin: 6 }}>
							<Animated.View
								style={[
									scanLineStyle,
									{
										width: "100%",
										height: 2,
										backgroundColor: "rgba(255, 255, 255, 0.85)",
										shadowColor: "#ffffff",
										shadowOpacity: 0.9,
										shadowRadius: 6,
										elevation: 4,
									},
								]}
							/>
						</View>
					)}
				</Animated.View>

				{/* Top Bar: Close Button, Title, Flashlight Torch Toggle (Identical to Google Header) */}
				<View
					style={{ paddingTop: Math.max(insets.top + 6, 20) }}
					className="absolute left-0 right-0 top-0 flex-row items-center justify-between px-5"
				>
					{/* Close Button: Circular semi-transparent with 'X' */}
					<Pressable
						onPress={() => {
							haptic.tap();
							onClose();
						}}
						hitSlop={12}
						className="h-11 w-11 items-center justify-center rounded-full bg-neutral-900/75 active:bg-neutral-800"
					>
						<Text style={{ fontSize: 20, color: "#ffffff", fontWeight: "300", lineHeight: 22 }}>✕</Text>
					</Pressable>

					{/* Header Title */}
					<Text className="text-[17px] font-semibold text-white tracking-wide">
						{lockedTarget ? "已识别二维码" : title}
					</Text>

					{/* Torch Flashlight Toggle */}
					<Pressable
						onPress={() => {
							haptic.tap();
							setTorch((prev) => !prev);
						}}
						hitSlop={12}
						className={`h-11 w-11 items-center justify-center rounded-full active:bg-neutral-800 ${
							torch ? "bg-amber-400" : "bg-neutral-900/75"
						}`}
					>
						<Text style={{ fontSize: 18, color: torch ? "#000000" : "#ffffff" }}>
							{torch ? "⚡" : "🔦"}
						</Text>
					</Pressable>
				</View>

				{/* Bottom Google-Style Subtitle Hint */}
				<View
					style={{ paddingBottom: Math.max(insets.bottom + 20, 32) }}
					className="absolute bottom-0 left-0 right-0 items-center px-8"
				>
					<View className="rounded-full bg-neutral-950/70 px-6 py-2.5 backdrop-blur-md">
						<Text className="text-[13px] font-medium text-neutral-300">
							将二维码置于框内即可自动识别
						</Text>
					</View>
				</View>
			</View>
		</Modal>
	);
}
