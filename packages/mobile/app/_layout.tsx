import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { LogBox, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import { useMobile } from "../src/store";
import { useThemeColors, useThemeStore } from "../src/theme";
import { darkThemeVariables, lightThemeVariables } from "../src/themeVariables";
import "../global.css";

// Prevent the native splash screen from auto-hiding before state is hydrated
void SplashScreen.preventAutoHideAsync().catch(() => {});

// Ignore Expo CLI HMR connection warning when running over network or relay
LogBox.ignoreLogs(["Cannot connect to Expo CLI."]);

export default function RootLayout() {
	const hydrate = useMobile((s) => s.hydrate);
	const hydrated = useMobile((s) => s.hydrated);
	const initPreference = useThemeStore((s) => s.initPreference);
	const { colors, isDark } = useThemeColors();

	useEffect(() => {
		void hydrate();
		void initPreference();
	}, [hydrate, initPreference]);

	useEffect(() => {
		if (hydrated) {
			// Hide the native splash screen smoothly after the first frame has painted
			const timer = setTimeout(() => {
				void SplashScreen.hideAsync().catch(() => {});
			}, 100);
			return () => clearTimeout(timer);
		}
	}, [hydrated]);

	return (
		<GestureHandlerRootView style={[{ flex: 1, backgroundColor: colors.shell }, isDark ? darkThemeVariables : lightThemeVariables]}>
			<View className="flex-1" style={[{ backgroundColor: colors.shell }, isDark ? darkThemeVariables : lightThemeVariables]}>
				<SafeAreaProvider initialMetrics={initialWindowMetrics}>
					<StatusBar style={isDark ? "light" : "dark"} />
					<Stack
						screenOptions={{
							headerStyle: { backgroundColor: colors.shell },
							headerTintColor: colors.ink,
							headerTitleStyle: { fontSize: 18, fontWeight: "700" },
							headerShadowVisible: false,
							contentStyle: { backgroundColor: colors.shell },
							animation: "ios_from_right",
							animationDuration: 220,
						}}
					>
						<Stack.Screen
							name="index"
							options={{
								headerShown: false,
							}}
						/>
						<Stack.Screen
							name="pair"
							options={{
								headerShown: false,
							}}
						/>
						<Stack.Screen
							name="usage"
							options={{
								headerShown: false,
							}}
						/>
						<Stack.Screen
							name="git-status"
							options={{
								presentation: "transparentModal",
								animation: "fade",
								headerShown: false,
								contentStyle: { backgroundColor: "transparent" },
							}}
						/>
						<Stack.Screen
							name="file-viewer"
							options={{
								presentation: "transparentModal",
								animation: "fade",
								headerShown: false,
								contentStyle: { backgroundColor: "transparent" },
							}}
						/>
						<Stack.Screen
							name="session/[id]"
							options={{
								headerShown: false,
							}}
						/>
					</Stack>
				</SafeAreaProvider>
			</View>
		</GestureHandlerRootView>
	);
}
