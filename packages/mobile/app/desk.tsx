import { useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { bridgeScript } from "../src/bridge";
import { useMobile } from "../src/store";

/**
 * The desktop's own interface, on the phone.
 *
 * Not a copy of it — the actual build, loaded from the machine this phone is paired with, so the
 * two are the same by construction rather than by discipline. What this file adds is the three
 * things a WebView cannot work out for itself: where to load from, what `window.lyra` is, and how
 * to sit inside a phone's chrome.
 *
 * The safe area is handled here rather than in the page. The renderer's layout already knows how
 * to be narrow (it goes there whenever a desktop window is dragged in), and it has no notion of a
 * notch or a home indicator — those are the phone's, so they are padding around the WebView
 * instead of a media query inside it.
 */
export default function DeskScreen() {
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const connection = useMobile((s) => s.connection);

	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState<string | null>(null);
	/*
	 * `WebView<object>`, not `WebView`.
	 *
	 * The library declares `class WebView<P = undefined> extends Component<WebViewProps & P>`, and
	 * `WebViewProps & undefined` collapses to `never` under strict mode — so the bare form accepts
	 * no props at all. Naming the parameter restores the intersection. A library-side bug, worked
	 * around rather than patched.
	 */
	const webview = useRef<WebView<object>>(null);

	const reload = useCallback(() => {
		setFailed(null);
		setLoading(true);
		webview.current?.reload();
	}, []);

	if (!connection) {
		return (
			<View className="flex-1 items-center justify-center bg-shell px-8" style={{ paddingTop: insets.top }}>
				<Text className="text-center text-[15px] text-ink">还没有连接桌面端</Text>
				<Pressable onPress={() => router.replace("/pair")} className="mt-5 rounded-xl bg-ink px-5 py-3 active:opacity-85">
					<Text className="text-[14px] font-medium text-shell">去配对</Text>
				</Pressable>
			</View>
		);
	}

	const scheme = connection.tls ? "https" : "http";
	const origin = `${scheme}://${connection.host}:${connection.port}`;

	return (
		<View className="flex-1 bg-shell" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
			<WebView<object>
				ref={webview}
				source={{ uri: `${origin}/app` }}
				/*
				 * Injected before the page's own scripts, because the very first thing the app does
				 * is read `window.lyra`. `injectedJavaScript` — without the suffix — runs after
				 * load, which is far too late: the renderer would already have crashed looking for
				 * an interface that was not there yet.
				 */
				injectedJavaScriptBeforeContentLoaded={bridgeScript(connection)}
				onLoadEnd={() => setLoading(false)}
				onError={({ nativeEvent }) => {
					setLoading(false);
					setFailed(nativeEvent.description || "打不开桌面端");
				}}
				onHttpError={({ nativeEvent }) => {
					setLoading(false);
					setFailed(`桌面端返回 ${nativeEvent.statusCode}`);
				}}
				/*
				 * Belt and braces against the focus zoom.
				 *
				 * The page it loads already asks for `maximum-scale=1`, but iOS has honoured that
				 * inconsistently across versions — and when it does zoom, the damage outlives the
				 * keyboard: the viewport stays wide and the send button stays off-screen. These two
				 * settle it at the WebView rather than relying on the page being obeyed.
				 */
				scalesPageToFit={false}
				setBuiltInZoomControls={false}
				// The renderer manages its own scrolling regions; a bouncing page underneath them
				// makes the whole interface feel detached from the phone.
				bounces={false}
				overScrollMode="never"
				// Keyboard handling belongs to the page's own layout, which already reserves for it.
				automaticallyAdjustContentInsets={false}
				contentInsetAdjustmentBehavior="never"
				// The app is one origin; anything else is a link someone tapped, and belongs in a
				// browser rather than inside the session view.
				originWhitelist={[origin]}
				onShouldStartLoadWithRequest={(request) => request.url.startsWith(origin)}
				// Text selection and long-press callouts read as a web page rather than an app.
				{...(Platform.OS === "ios" ? { allowsLinkPreview: false } : {})}
				style={{ backgroundColor: "transparent" }}
			/>

			{loading && (
				<View className="absolute inset-0 items-center justify-center bg-shell">
					<ActivityIndicator color="#9a9a9a" />
					<Text className="mt-3 text-[12.5px] text-ink-faint">正在加载桌面端界面…</Text>
				</View>
			)}

			{failed && (
				<View className="absolute inset-0 items-center justify-center bg-shell px-8">
					<Text className="text-center text-[15px] font-medium text-ink">连不上桌面端</Text>
					<Text className="mt-2 text-center text-[13px] leading-6 text-ink-muted">{failed}</Text>
					<Text className="mt-1 text-center text-[12px] text-ink-faint">
						{origin}
					</Text>
					<View className="mt-6 flex-row gap-3">
						<Pressable onPress={reload} className="rounded-xl bg-ink px-5 py-3 active:opacity-85">
							<Text className="text-[14px] font-medium text-shell">重试</Text>
						</Pressable>
						<Pressable
							onPress={() => router.replace("/pair")}
							className="rounded-xl border border-line px-5 py-3 active:bg-card-hover"
						>
							<Text className="text-[14px] text-ink-muted">重新配对</Text>
						</Pressable>
					</View>
				</View>
			)}
		</View>
	);
}
