import { useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SyncClient } from "../src/client";
import { haptic } from "../src/haptics";
import { MobileQrScannerModal } from "../src/MobileQrScannerModal";
import { SettingsAgentSection } from "../src/SettingsAgentSection";
import { useMobile } from "../src/store";
import { useThemeColors } from "../src/theme";

export default function PairScreen() {
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const connection = useMobile((s) => s.connection);
	const pair = useMobile((s) => s.pair);
	const unpair = useMobile((s) => s.unpair);
	const settings = useMobile((s) => s.settings);
	const updateRemoteSettings = useMobile((s) => s.updateRemoteSettings);
	const { preference, setPreference } = useThemeColors();

	const [host, setHost] = useState(connection?.host ?? "");
	const [port, setPort] = useState(String(connection?.port ?? 4517));
	const [token, setToken] = useState(connection?.token ?? "");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const [showManualForm, setShowManualForm] = useState(!connection);

	const [scannerOpen, setScannerOpen] = useState(false);
	const [permission, requestPermission] = useCameraPermissions();

	function parsePairingUrl(raw: string): { host: string; port: string; token: string; relay?: boolean; secure?: boolean } | null {
		const text = raw.trim();
		const match = /lyra:\/\/pair\?(.*)/.exec(text);
		if (!match) return null;
		const params = new URLSearchParams(match[1]);
		const relay = params.get("relay");
		const t = params.get("token");
		if (!t) return null;

		if (relay) {
			// Relay mode: relay=wss://example.com:9000 or ws://...
			try {
				const u = new URL(/^[a-z]+:\/\//i.test(relay) ? relay : `wss://${relay}`);
				const p = u.port ? u.port : u.protocol === "ws:" ? "80" : "443";
				return { host: u.hostname, port: p, token: t, relay: true, secure: u.protocol !== "ws:" };
			} catch {
				return null;
			}
		}

		const h = params.get("host");
		const p = params.get("port") ?? "4517";
		if (!h) return null;
		return { host: h, port: p, token: t };
	}

	async function pastePairingUrl() {
		haptic.tap();
		const text = await Clipboard.getStringAsync().catch(() => "");
		const parsed = parsePairingUrl(text);
		if (!parsed) {
			setMessage({ tone: "error", text: "剪贴板里没有找到有效的配对链接" });
			return;
		}
		setHost(parsed.host);
		setPort(parsed.port);
		setToken(parsed.token);
		setMessage({ tone: "ok", text: parsed.relay ? "已从剪贴板读取中转配对信息" : "已从剪贴板读取配对信息" });
	}

	async function startScan() {
		haptic.impact();
		if (!permission?.granted) {
			const res = await requestPermission();
			if (!res.granted) {
				setMessage({ tone: "error", text: "需要相机权限以扫描桌面端二维码" });
				return;
			}
		}
		setScannerOpen(true);
	}

	async function handleBarcodeScanned(data: string) {
		const parsed = parsePairingUrl(data);
		if (!parsed) {
			setMessage({ tone: "error", text: "未识别到有效的 Lyra 配对二维码" });
			setScannerOpen(false);
			return;
		}

		setHost(parsed.host);
		setPort(parsed.port);
		setToken(parsed.token);
		setScannerOpen(false);
		setMessage({ tone: "ok", text: "已成功扫码，正在自动连接…" });
		await testAndSave(parsed.host, parsed.port, parsed.token, parsed.relay);
	}

	async function testAndSave(targetHost = host, targetPort = port, targetToken = token, isRelay = false) {
		haptic.impact();
		setBusy(true);
		try {
			const cleanHost = targetHost
				.replace(/^https?:\/\//i, "")
				.replace(/\/.*$/, "")
				.replace(/:\d+$/, "")
				.trim();
			const parsedPort = Number(targetPort);
			if (!cleanHost || !Number.isFinite(parsedPort) || !targetToken.trim()) {
				setMessage({ tone: "error", text: "请填写完整的地址、端口和令牌" });
				return;
			}

			if (isRelay) {
				const isPlainWs = /^ws:\/\//i.test(targetHost);
				const res = await pair({
					host: cleanHost,
					port: parsedPort,
					token: targetToken.trim(),
					secure: !isPlainWs,
					relay: true,
				});
				if (res.ok) {
					haptic.success();
					setMessage(null);
					setShowManualForm(false);
					router.back();
				} else {
					haptic.warning();
					setMessage({ tone: "error", text: res.reason || "中转连接失败，请确认中转服务正在运行。" });
				}
				return;
			}

			const pingResult = await SyncClient.ping(targetHost, parsedPort);
			if (!pingResult.ok) {
				setMessage({
					tone: "error",
					text: `无法连接到 ${cleanHost}:${parsedPort}，请确认电脑和手机在同一网络，且同步服务已启用。`,
				});
				return;
			}

			const res = await pair({
				host: cleanHost,
				port: parsedPort,
				token: targetToken.trim(),
				secure: pingResult.secure,
			});
			if (res.ok) {
				haptic.success();
				setMessage(null);
				setShowManualForm(false);
				router.back();
			} else {
				haptic.warning();
				setMessage({ tone: "error", text: res.reason || "令牌不正确，请在桌面端重新复制或刷新二维码。" });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<KeyboardAvoidingView className="flex-1 bg-shell" behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ paddingTop: insets.top }}>
			{/* Custom Compact Header */}
			<View className="h-14 flex-row items-center bg-shell px-3.5">
				<Pressable
					onPress={() => router.back()}
					hitSlop={8}
					className="h-9 w-9 items-center justify-center rounded-full bg-elevated active:opacity-85"
				>
					<View className="h-4 w-4 items-center justify-center">
						<View
							className="h-2.5 w-2.5 border-b-2 border-l-2 border-ink"
							style={{ transform: [{ rotate: "45deg" }, { translateX: 1 }] }}
						/>
					</View>
				</Pressable>
				<Text className="ml-2.5 text-[17px] font-bold text-ink">设置</Text>
			</View>
			<ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 54 }}>
				{/* Agent Execution & Personalization Preferences */}
				{connection && (
					<SettingsAgentSection settings={settings} updateRemoteSettings={updateRemoteSettings} />
				)}

				{/* Appearance Settings */}
				<View className="mb-5 rounded-2xl bg-card p-4">
					<Text className="mb-3 text-[14px] font-semibold text-ink">外观与主题</Text>
					<View className="flex-row items-center gap-2">
						{(
							[
								{ id: "system", label: "跟随系统" },
								{ id: "light", label: "浅色" },
								{ id: "dark", label: "深色" },
							] as const
						).map((item) => {
							const active = preference === item.id;
							return (
								<Pressable
									key={item.id}
									onPress={() => {
										haptic.tap();
										setPreference(item.id);
									}}
									className={`flex-1 items-center justify-center rounded-xl py-2.5 ${
										active ? "bg-accent" : "bg-elevated active:opacity-80"
									}`}
								>
									<Text className={`text-[13px] font-medium ${active ? "text-white" : "text-ink-muted"}`}>
										{item.label}
									</Text>
								</Pressable>
							);
						})}
					</View>
				</View>

				{/* Desktop Connection Card */}
				<View className="mb-5 rounded-2xl bg-card p-4">
					<View className="mb-3 flex-row items-center justify-between">
						<Text className="text-[14px] font-semibold text-ink">桌面端连接</Text>
						<View className="flex-row items-center gap-1.5">
							<View className={`h-2 w-2 rounded-full ${connection ? "bg-ok" : "bg-ink-faint"}`} />
							<Text className="text-[12px] font-medium text-ink-muted">
								{connection ? `已配对 (${connection.host}:${connection.port})` : "未配对"}
							</Text>
						</View>
					</View>

					<Pressable
						onPress={() => void startScan()}
						className="flex-row items-center justify-center gap-2 rounded-xl bg-accent py-3 px-4 active:opacity-90"
					>
						<Text className="text-[14px] font-semibold text-white">扫码快速连接桌面端</Text>
					</Pressable>

					<Pressable
						onPress={() => void pastePairingUrl()}
						className="mt-2.5 items-center rounded-xl bg-elevated py-2.5 active:opacity-80"
					>
						<Text className="text-[12.5px] text-ink-muted">从剪贴板读取配对链接</Text>
					</Pressable>

					{connection && (
						<Pressable
							onPress={() => setShowManualForm(!showManualForm)}
							className="mt-2.5 items-center py-1.5"
						>
							<Text className="text-[12px] text-ink-faint">
								{showManualForm ? "收起手动输入设置 ▲" : "修改地址与令牌 ▼"}
							</Text>
						</Pressable>
					)}

					{showManualForm && (
						<View className="mt-3 border-t border-shell/50 pt-3">
							<Field label="局域网地址 / 公网域名">
								<TextInput
									value={host}
									onChangeText={setHost}
									placeholder="192.168.1.10 或 sync.example.com"
									placeholderTextColor="#6e6e6e"
									autoCapitalize="none"
									autoCorrect={false}
									keyboardType="numbers-and-punctuation"
									className="h-10 rounded-xl bg-input px-3 text-[13.5px] text-ink"
								/>
							</Field>

							<Field label="端口">
								<TextInput
									value={port}
									onChangeText={setPort}
									placeholder="4517"
									placeholderTextColor="#6e6e6e"
									keyboardType="number-pad"
									className="h-10 rounded-xl bg-input px-3 text-[13.5px] text-ink"
								/>
							</Field>

							<Field label="配对令牌">
								<TextInput
									value={token}
									onChangeText={setToken}
									placeholder="桌面端生成的令牌"
									placeholderTextColor="#6e6e6e"
									autoCapitalize="none"
									autoCorrect={false}
									className="h-10 rounded-xl bg-input px-3 text-[13.5px] text-ink"
								/>
							</Field>

							<Pressable
								disabled={busy}
								onPress={() => void testAndSave()}
								className="mt-3 h-11 items-center justify-center rounded-xl bg-ink active:opacity-85 disabled:opacity-50"
							>
								{busy ? (
									<ActivityIndicator color="#171717" />
								) : (
									<Text className="text-[14px] font-medium text-shell">连接桌面端</Text>
								)}
							</Pressable>
						</View>
					)}

					{message && (
						<View
							style={{
								backgroundColor: message.tone === "ok" ? "#14281f" : "#2d1618",
							}}
							className="mt-3 rounded-xl px-3.5 py-2.5"
						>
							<Text className={`text-[12.5px] leading-4 ${message.tone === "ok" ? "text-ok" : "text-danger"}`}>
								{message.text}
							</Text>
						</View>
					)}

					{connection && (
						<Pressable
							onPress={() => {
								haptic.heavy();
								void unpair();
								router.back();
							}}
							className="mt-3 h-10 items-center justify-center rounded-xl bg-elevated active:opacity-80"
						>
							<Text className="text-[13px] text-danger">断开当前桌面端连接</Text>
						</Pressable>
					)}
				</View>

				{/* 4. About */}
				<View className="items-center py-2">
					<Text className="text-[11.5px] text-ink-faint">Lyra Mobile Companion · v0.7.0</Text>
				</View>
			</ScrollView>

			{/* Google Code Scanner Style Fullscreen Scanner Modal */}
			<MobileQrScannerModal
				visible={scannerOpen}
				title="对准桌面端配对二维码"
				onClose={() => setScannerOpen(false)}
				onScanned={handleBarcodeScanned}
			/>
		</KeyboardAvoidingView>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<View className="mb-2.5">
			<Text className="mb-1 text-[11.5px] font-medium text-ink-muted">{label}</Text>
			{children}
		</View>
	);
}
