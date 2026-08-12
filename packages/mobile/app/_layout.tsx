import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useMobile } from "../src/store";
import "../global.css";

export default function RootLayout() {
	const hydrate = useMobile((s) => s.hydrate);

	useEffect(() => {
		void hydrate();
	}, [hydrate]);

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
					<Stack.Screen name="index" options={{ title: "DeepWise" }} />
					<Stack.Screen name="pair" options={{ title: "连接桌面端", presentation: "modal" }} />
					<Stack.Screen name="session/[id]" options={{ title: "会话" }} />
				</Stack>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
