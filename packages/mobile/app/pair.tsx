import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
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

	async function pastePairingUrl() {
		const text = await Clipboard.getStringAsync().catch(() => "");
		// The desktop copies a lyra://pair?host=…&port=…&token=… payload.
		const match = /lyra:\/\/pair\?(.*)/.exec(text.trim());
		if (!match) {
			setMessage({ tone: "error", text: "剪贴板里没有找到配对链接" });
			return;
		}
		const params = new URLSearchParams(match[1]);
		setHost(params.get("host") ?? "");
		setPort(params.get("port") ?? "4517");
		setToken(params.get("token") ?? "");
		setMessage({ tone: "ok", text: "已从剪贴板读取配对信息" });
	}

	async function testAndSave() {
		setBusy(true);
		try {
			const cleanHost = host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").trim();
			const parsedPort = Number(port);
			if (!cleanHost || !Number.isFinite(parsedPort) || !token.trim()) {
				setMessage({ tone: "error", text: "请填写完整的地址、端口和令牌" });
				return;
			}

			const pingResult = await SyncClient.ping(cleanHost, parsedPort);
			if (!pingResult.ok) {
				setMessage({
					tone: "error",
					text: `无法连接到 ${cleanHost}:${parsedPort} (${pingResult.reason || "网络超时"})，请确认电脑和手机在同一网络。`,
				});
				return;
			}

			const ok = await pair({ host: cleanHost, port: parsedPort, token: token.trim() });
			if (ok) {
				setMessage(null);
				router.back();
			} else {
				setMessage({ tone: "error", text: "令牌不正确，请在桌面端重新复制。" });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<KeyboardAvoidingView className="flex-1 bg-shell" behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
				<Text className="text-[13.5px] leading-6 text-ink-muted">
					在桌面端打开「设置 → 移动端同步」，启用服务后复制配对链接，或手动填写下面三项。
				</Text>

				<Pressable
					onPress={() => void pastePairingUrl()}
					className="mt-4 items-center rounded-xl border border-dashed border-line py-3 active:bg-card-hover"
				>
					<Text className="text-[13px] text-ink-muted">从剪贴板粘贴配对链接</Text>
				</Pressable>

				<Field label="局域网地址">
					<TextInput
						value={host}
						onChangeText={setHost}
						placeholder="192.168.1.10"
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
