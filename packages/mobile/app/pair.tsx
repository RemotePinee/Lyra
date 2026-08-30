import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { SyncClient } from "../src/client";
import { useMobile } from "../src/store";

export default function PairScreen() {
	const router = useRouter();
	const connection = useMobile((s) => s.connection);
	const pair = useMobile((s) => s.pair);
	const unpair = useMobile((s) => s.unpair);

	const [host, setHost] = useState(connection?.host ?? "");
	const [port, setPort] = useState(String(connection?.port ?? 4517));
	const [token, setToken] = useState(connection?.token ?? "");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

	// Camera & Scanner State
	const [scannerOpen, setScannerOpen] = useState(false);
	const [permission, requestPermission] = useCameraPermissions();
	const [scanned, setScanned] = useState(false);

	function parsePairingUrl(raw: string): { host: string; port: string; token: string } | null {
		const text = raw.trim();
		const match = /lyra:\/\/pair\?(.*)/.exec(text);
		if (!match) return null;
		const params = new URLSearchParams(match[1]);
		const h = params.get("host");
		const p = params.get("port") ?? "4517";
		const t = params.get("token");
		if (!h || !t) return null;
		return { host: h, port: p, token: t };
	}

	async function pastePairingUrl() {
		const text = await Clipboard.getStringAsync().catch(() => "");
		const parsed = parsePairingUrl(text);
		if (!parsed) {
			setMessage({ tone: "error", text: "剪贴板里没有找到有效的配对链接" });
			return;
		}
		setHost(parsed.host);
		setPort(parsed.port);
		setToken(parsed.token);
		setMessage({ tone: "ok", text: "已从剪贴板读取配对信息" });
	}

	async function startScan() {
		if (!permission?.granted) {
			const res = await requestPermission();
			if (!res.granted) {
				setMessage({ tone: "error", text: "需要相机权限以扫描桌面端二维码" });
				return;
			}
		}
		setScanned(false);
		setScannerOpen(true);
	}

	async function handleBarcodeScanned({ data }: { data: string }) {
		if (scanned) return;
		setScanned(true);
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

		// Automatically trigger test & save
		await testAndSave(parsed.host, parsed.port, parsed.token);
	}

	async function testAndSave(targetHost = host, targetPort = port, targetToken = token) {
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

			const pingResult = await SyncClient.ping(targetHost, parsedPort);
			if (!pingResult.ok) {
				setMessage({
					tone: "error",
					text: `无法连接到 ${cleanHost}:${parsedPort}，请确认电脑和手机在同一网络（或公网反代可达），且同步服务已启用。`,
				});
				return;
			}

			const ok = await pair({
				host: cleanHost,
				port: parsedPort,
				token: targetToken.trim(),
				secure: pingResult.secure,
			});
			if (ok) {
				setMessage(null);
				router.back();
			} else {
				setMessage({ tone: "error", text: "令牌不正确，请在桌面端重新复制或刷新二维码。" });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<KeyboardAvoidingView
			className="flex-1 bg-shell"
			behavior={Platform.OS === "ios" ? "padding" : "height"}
		>
			<ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
				<Text className="text-[13.5px] leading-6 text-ink-muted">
					在桌面端打开「设置 → 移动端同步」，启用服务后直接扫描桌面端显示的二维码，或输入配对信息。
				</Text>

				{/* Primary Action: QR Code Scan Button */}
				<Pressable
					onPress={() => void startScan()}
					className="mt-4 flex-row items-center justify-center gap-2 rounded-xl bg-accent py-3.5 px-4 shadow-sm active:opacity-90"
				>
					<Text className="text-[15px] font-semibold text-white">扫码一键连接</Text>
				</Pressable>

				<Pressable
					onPress={() => void pastePairingUrl()}
					className="mt-3 items-center rounded-xl border border-dashed border-line py-3 active:bg-card-hover"
				>
					<Text className="text-[13px] text-ink-muted">从剪贴板粘贴配对链接</Text>
				</Pressable>

				<View className="mt-6 mb-2 flex-row items-center gap-3">
					<View className="h-[1px] flex-1 bg-line-soft" />
					<Text className="text-[11.5px] text-ink-faint">或手动输入</Text>
					<View className="h-[1px] flex-1 bg-line-soft" />
				</View>

				<Field label="局域网地址 / 公网域名">
					<TextInput
						value={host}
						onChangeText={setHost}
						placeholder="192.168.1.10 或 sync.example.com"
						placeholderTextColor="#6e6e6e"
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="numbers-and-punctuation"
						className="h-11 rounded-xl border border-line bg-input px-3.5 text-[14px] text-ink"
					/>
				</Field>

				<Field label="端口">
					<TextInput
						value={port}
						onChangeText={setPort}
						placeholder="4517"
						placeholderTextColor="#6e6e6e"
						keyboardType="number-pad"
						className="h-11 rounded-xl border border-line bg-input px-3.5 text-[14px] text-ink"
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
						className="h-11 rounded-xl border border-line bg-input px-3.5 text-[14px] text-ink"
					/>
				</Field>

				{message && (
					<View
						style={{
							backgroundColor: message.tone === "ok" ? "#14281f" : "#2d1618",
							borderColor: message.tone === "ok" ? "#22593d" : "#5c2427",
						}}
						className="mt-4 rounded-xl border px-3.5 py-3"
					>
						<Text className={`text-[13px] leading-5 ${message.tone === "ok" ? "text-ok" : "text-danger"}`}>
							{message.text}
						</Text>
					</View>
				)}

				<Pressable
					disabled={busy}
					onPress={() => void testAndSave()}
					className="mt-6 h-12 items-center justify-center rounded-xl bg-ink active:opacity-85 disabled:opacity-50"
				>
					{busy ? <ActivityIndicator color="#171717" /> : <Text className="text-[15px] font-medium text-shell">连接</Text>}
				</Pressable>

				{connection && (
					<Pressable
						onPress={() => {
							void unpair();
							router.back();
						}}
						className="mt-3 h-12 items-center justify-center rounded-xl border border-line active:bg-card-hover"
					>
						<Text className="text-[14px] text-danger">断开连接</Text>
					</Pressable>
				)}
			</ScrollView>

			{/* Fullscreen Scanner Modal */}
			<Modal visible={scannerOpen} animationType="slide" onRequestClose={() => setScannerOpen(false)}>
				<View className="flex-1 bg-black">
					<CameraView
						style={StyleSheet.absoluteFill}
						facing="back"
						barcodeScannerSettings={{
							barcodeTypes: ["qr"],
						}}
						onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
					/>

					{/* Overlay & Frame */}
					<View className="flex-1 items-center justify-between p-8 pt-16">
						<View className="rounded-full bg-black/60 px-5 py-2">
							<Text className="text-[14px] font-medium text-white">对准桌面端设置中的配对二维码</Text>
						</View>

						{/* Reticle Focus Box */}
						<View className="h-64 w-64 rounded-3xl border-2 border-accent bg-transparent" />

						<Pressable
							onPress={() => setScannerOpen(false)}
							className="rounded-full bg-white/20 px-8 py-3 backdrop-blur-md active:bg-white/30"
						>
							<Text className="text-[15px] font-medium text-white">取消扫码</Text>
						</Pressable>
					</View>
				</View>
			</Modal>
		</KeyboardAvoidingView>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<View className="mt-4">
			<Text className="mb-1.5 text-[12.5px] text-ink-muted">{label}</Text>
			{children}
		</View>
	);
}
