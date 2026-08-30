import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useMobile } from "../src/store";
import "../global.css";

const appIcon = require("../assets/logo.png");

function HeaderTitle() {
	return (
		<View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
			<Image
				source={appIcon}
				style={{ width: 34, height: 34 }}
				resizeMode="contain"
			/>
			<Text style={{ fontSize: 24, fontWeight: "700", color: "#ededed", letterSpacing: 0.3 }}>Lyra</Text>
		</View>
	);
}

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
						headerStyle: { backgroundColor: "#171717" },
						headerTintColor: "#ededed",
						headerTitleStyle: { fontSize: 18, fontWeight: "700" },
						headerShadowVisible: false,
						contentStyle: { backgroundColor: "#171717" },
					}}
				>
					<Stack.Screen
						name="index"
						options={{
							headerTitle: () => <HeaderTitle />,
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
