import Constants, { ExecutionEnvironment } from "expo-constants";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect } from "react";
import { LogBox, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import { useMobile } from "../src/store";
import { useThemeColors, useThemeStore } from "../src/theme";
import { darkThemeVariables, lightThemeVariables } from "../src/themeVariables";
import "../global.css";

// Prevent native splash screen from hiding before root view layout paints
void SplashScreen.preventAutoHideAsync().catch(() => {});
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
if (!isExpoGo) {
	try {
		// Only run when setOptions is a valid function on standalone/development builds
		if (typeof (SplashScreen as any).setOptions === "function") {
			(SplashScreen as any).setOptions({ duration: 300, fade: true });
		}
	} catch {
		// Ignore setOptions failure in environments where not supported
	}
}

// Ignore Expo CLI HMR and Expo Go splash warnings
LogBox.ignoreLogs([
	"Cannot connect to Expo CLI.",
	"'Splashscreen.setOptions' cannot be used in Expo Go",
	"'SplashScreen.setOptions' cannot be used in Expo Go",
	"SplashScreen.setOptions",
]);

export default function RootLayout() {
	const hydrate = useMobile((s) => s.hydrate);
	const hydrated = useMobile((s) => s.hydrated);
	const initPreference = useThemeStore((s) => s.initPreference);
	const themeInitialized = useThemeStore((s) => s.initialized);
	const { colors, isDark } = useThemeColors();

	useEffect(() => {
		void hydrate();
		void initPreference();
	}, [hydrate, initPreference]);

	const onRootLayout = useCallback(() => {
		if (hydrated && themeInitialized) {
			void SplashScreen.hideAsync().catch(() => {});
		}
	}, [hydrated, themeInitialized]);

	useEffect(() => {
		if (hydrated && themeInitialized) {
			void SplashScreen.hideAsync().catch(() => {});
		}
	}, [hydrated, themeInitialized]);

	return (
		<GestureHandlerRootView
			onLayout={onRootLayout}
			style={[{ flex: 1, backgroundColor: colors.shell }, isDark ? darkThemeVariables : lightThemeVariables]}
		>
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
