import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import { useMobile } from "../src/store";
import "../global.css";

// Prevent the native splash screen from auto-hiding before state is hydrated
void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
	const hydrate = useMobile((s) => s.hydrate);
	const hydrated = useMobile((s) => s.hydrated);

	useEffect(() => {
		void hydrate();
	}, [hydrate]);

	useEffect(() => {
		if (hydrated) {
			// Hide the native splash screen once store hydration completes
			void SplashScreen.hideAsync().catch(() => {});
		}
	}, [hydrated]);

	return (
		<GestureHandlerRootView style={{ flex: 1, backgroundColor: "#171717" }}>
			<SafeAreaProvider initialMetrics={initialWindowMetrics}>
				<StatusBar style="light" />
				<Stack
					screenOptions={{
						headerStyle: { backgroundColor: "#171717" },
						headerTintColor: "#ededed",
						headerTitleStyle: { fontSize: 18, fontWeight: "700" },
						headerShadowVisible: false,
						contentStyle: { backgroundColor: "#171717" },
						animation: "slide_from_right",
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
							title: "连接桌面端",
							presentation: "modal",
							headerStyle: { backgroundColor: "#1c1c1c" },
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
		</GestureHandlerRootView>
	);
}
