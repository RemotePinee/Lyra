import React, { useEffect } from "react";
import { View, StyleSheet, useColorScheme } from "react-native";
import Animated, {
	useSharedValue,
	useAnimatedStyle,
	withRepeat,
	withTiming,
	withSequence,
	Easing,
	type SharedValue,
} from "react-native-reanimated";

interface MobileThinkingOrbProps {
	state?: string;
	size?: number;
}

interface DotDef {
	id: number;
	angle: number;
	baseR: number;
	dotSize: number;
	tilt: number;
	freq: number;
	phaseOffset: number;
}

function SmoothWaveDot({
	dot,
	center,
	baseRgb,
	wavePhase,
}: {
	dot: DotDef;
	center: number;
	baseRgb: string;
	wavePhase: SharedValue<number>;
}) {
	// Fixed layout positions, never touch width/height/left/top during animation
	const x = center + dot.baseR * Math.cos(dot.angle) - dot.dotSize / 2;
	const y = center + dot.baseR * Math.sin(dot.angle) * dot.tilt - dot.dotSize / 2;

	const animStyle = useAnimatedStyle(() => {
		// Continuous travelling sinusoidal wave along the ring: zero jumping, purely smooth
		const w = Math.sin(dot.angle * dot.freq - wavePhase.value + dot.phaseOffset);
		const norm = (w + 1) / 2; // 0 to 1

		// Scale smoothly morphs between 0.65 and 1.35
		const scale = 0.65 + 0.7 * norm;
		// Opacity smoothly travels between 0.22 and 0.95
		const opacity = 0.22 + 0.73 * norm;

		return {
			transform: [{ scale }],
			opacity,
		};
	});

	return (
		<Animated.View
			style={[
				{
					position: "absolute",
					left: x,
					top: y,
					width: dot.dotSize,
					height: dot.dotSize,
					borderRadius: dot.dotSize / 2,
					backgroundColor: `rgb(${baseRgb})`,
				},
				animStyle,
			]}
		/>
	);
}

export const MobileThinkingOrb = React.memo(function MobileThinkingOrb({
	size = 20,
}: MobileThinkingOrbProps) {
	const colorScheme = useColorScheme();
	const isDark = colorScheme !== "light";
	const baseRgb = isDark ? "255, 255, 255" : "17, 24, 39";

	// 1. Smooth traveling wave phase (driving fluid particle morphing)
	const wavePhase = useSharedValue(0);
	// 2. Slow subtle in-place drift
	const rotation = useSharedValue(0);
	// 3. Gentle in-place breathing
	const breathScale = useSharedValue(0.94);

	useEffect(() => {
		// Continuous linear wave flow without seams
		wavePhase.value = withRepeat(
			withTiming(Math.PI * 2, {
				duration: 2400,
				easing: Easing.linear,
			}),
			-1,
			false,
		);

		// Slow calm overall ring drift
		rotation.value = withRepeat(
			withTiming(360, {
				duration: 6400,
				easing: Easing.linear,
			}),
			-1,
			false,
		);

		// Deep breathing pulsation
		breathScale.value = withRepeat(
			withSequence(
				withTiming(1.06, { duration: 1800, easing: Easing.inOut(Easing.sin) }),
				withTiming(0.94, { duration: 1800, easing: Easing.inOut(Easing.sin) }),
			),
			-1,
			true,
		);
	}, [wavePhase, rotation, breathScale]);

	const center = size / 2;
	const rOuter = center * 0.74;
	const rInner = center * 0.46;

	// Dual-orbit structure: outer 10 dots + inner 5 dots
	const dots: DotDef[] = [
		// Outer wave orbit
		...Array.from({ length: 10 }).map((_, i) => ({
			id: i,
			angle: (i / 10) * Math.PI * 2,
			baseR: rOuter,
			dotSize: 1.8,
			tilt: 0.8,
			freq: 2, // 2 wave crests circling around
			phaseOffset: 0,
		})),
		// Inner counter-wave core
		...Array.from({ length: 5 }).map((_, i) => ({
			id: 10 + i,
			angle: (i / 5) * Math.PI * 2 + Math.PI / 5,
			baseR: rInner,
			dotSize: 1.3,
			tilt: 0.85,
			freq: 1,
			phaseOffset: Math.PI / 2,
		})),
	];

	const ringAnimatedStyle = useAnimatedStyle(() => ({
		transform: [
			{ rotate: `${rotation.value}deg` },
			{ scale: breathScale.value },
		],
	}));

	return (
		<View style={[styles.wrapper, { width: size, height: size }]}>
			<Animated.View
				style={[
					{
						width: size,
						height: size,
						position: "relative",
					},
					ringAnimatedStyle,
				]}
			>
				{dots.map((d) => (
					<SmoothWaveDot
						key={d.id}
						dot={d}
						center={center}
						baseRgb={baseRgb}
						wavePhase={wavePhase}
					/>
				))}
			</Animated.View>
		</View>
	);
});

const styles = StyleSheet.create({
	wrapper: {
		justifyContent: "center",
		alignItems: "center",
	},
});
