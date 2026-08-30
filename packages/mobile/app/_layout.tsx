import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useMobile } from "../src/store";
import "../global.css";

// Prevent the native splash screen from auto-hiding before state is hydrated
void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
	const hydrate = useMobile((s) => s.hydrate);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		async function prepare() {
			try {
				await hydrate();
			} finally {
				setReady(true);
			}
		}
		void prepare();
	}, [hydrate]);

	useEffect(() => {
		if (ready) {
			// Smoothly fade out splash screen once initial layout is ready
			void SplashScreen.hideAsync().catch(() => {});
		}
	}, [ready]);

	return (
		<GestureHandlerRootView style={{ flex: 1, backgroundColor: "#171717" }}>
			<SafeAreaProvider>
				<StatusBar style="light" />
				<Stack
					screenOptions={{
						headerStyle: { backgroundColor: "#1c1c1c" },
						headerTintColor: "#ededed",
						headerTitleStyle: { fontSize: 16, fontWeight: "600" },
						headerShadowVisible: false,
						contentStyle: { backgroundColor: "#171717" },
					}}
				>
					<Stack.Screen name="index" options={{ title: "Lyra" }} />
					<Stack.Screen name="pair" options={{ title: "连接桌面端", presentation: "modal" }} />
					<Stack.Screen name="session/[id]" options={{ title: "会话" }} />
				</Stack>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
