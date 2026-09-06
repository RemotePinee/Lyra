import { Check, ChevronDown, Copy, QrCode, RotateCw, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../store.ts";
import { Badge, Card, Field, GhostButton, Row, SectionTitle, TextInput, Toggle } from "./controls.tsx";
import { pairingCode, parseEndpoint, routeLabel, type PairingRoute } from "./pairing.ts";

/**
 * Connecting a phone, as one thing to point a camera at.
 *
 * The manual route — read an address, read a five-word token, type both on a phone keyboard — is
 * still here at the bottom, because a camera cannot always be the answer. But it is the fallback
 * now rather than the method: the token is long by design, it is the part people get wrong, and
 * getting it wrong produces a failure that says nothing about which character was mistyped.
 *
 * The address is a picker rather than a list because this machine cannot tell which of its
 * addresses the phone can reach. It ranks them (see `localAddresses`) and preselects the most
 * likely, and when that guess is wrong the fix is one click rather than a support question.
 */
export function SyncSettings() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const sync = useApp((s) => s.sync);
	const refreshSync = useApp((s) => s.refreshSync);

	const [port, setPort] = useState(String(settings?.sync.port ?? 4517));
	const [copied, setCopied] = useState<"token" | "code" | null>(null);
	const [manualOpen, setManualOpen] = useState(false);
	const [remoteOpen, setRemoteOpen] = useState(false);
	/** Which address the code carries. `null` follows the ranking, which is what it should do. */
	const [chosen, setChosen] = useState<string | null>(null);

	const [publicDraft, setPublicDraft] = useState(settings?.sync.publicUrl ?? "");
	const [relayDraft, setRelayDraft] = useState(settings?.sync.relayUrl ?? "");

	// Client count changes as the phone connects and disconnects.
	useEffect(() => {
		const timer = setInterval(() => void refreshSync(), 4000);
		return () => clearInterval(timer);
	}, [refreshSync]);

	// The fields follow the stored value when it changes elsewhere — another window, a reset.
	useEffect(() => {
		setPublicDraft(settings?.sync.publicUrl ?? "");
		setRelayDraft(settings?.sync.relayUrl ?? "");
	}, [settings?.sync.publicUrl, settings?.sync.relayUrl]);

	/**
	 * Every way this desktop can be reached, in the order worth trying.
	 *
	 * A relay comes first when one is configured: someone who set one up did it because the other
	 * two do not work from where their phone is.
	 */
	const routes = useMemo<PairingRoute[]>(() => {
		const out: PairingRoute[] = [];
		if (sync?.relayUrl) out.push({ kind: "relay", url: sync.relayUrl });
		if (sync?.publicUrl) out.push({ kind: "public", url: sync.publicUrl });
		for (const address of sync?.addresses ?? []) out.push({ kind: "lan", address, port: sync?.port ?? 4517 });
		return out;
	}, [sync?.relayUrl, sync?.publicUrl, sync?.addresses, sync?.port]);

	const active = routes.find((route) => keyOf(route) === chosen) ?? routes[0] ?? null;
	const code = active ? pairingCode(active, sync?.token ?? null) : null;

	if (!settings) return null;

	const running = sync?.running ?? false;

	return (
		<div className="pt-8">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">移动端同步</h1>
			<p className="mt-2 max-w-[600px] pb-7 text-label leading-relaxed text-ink-muted">
				手机与桌面端实时同步：随时查看正在进行的回合、批准操作、继续追问，两端状态毫秒级响应。
			</p>

			<SectionTitle>服务</SectionTitle>
			<Card className="mb-6">
				<Row
					title="启用同步服务"
					detail="在局域网启动 HTTP 与 WebSocket 同步服务，需安全令牌配对后方可访问。"
					control={
						<Toggle
							checked={running || settings.sync.enabled}
							onChange={(on) => {
								void (on ? window.lyra.sync.start() : window.lyra.sync.stop()).then(() => void refreshSync());
							}}
						/>
					}
				/>
				<Row
					title="服务状态"
					detail={running ? `${sync?.clients ?? 0} 个设备正在同步中` : "未运行"}
					control={<Badge tone={running ? "ok" : "muted"}>{running ? "运行中" : "已停止"}</Badge>}
				/>
				<div className="px-4 py-3.5">
					<Field label="监听端口">
						<TextInput
							value={port}
							onChange={setPort}
							mono
							inputMode="numeric"
							onBlur={() => {
								const parsed = Number(port);
								if (parsed > 0 && parsed < 65536 && parsed !== settings.sync.port) {
									void saveSettings({ ...settings, sync: { ...settings.sync, port: parsed } });
								}
							}}
						/>
					</Field>
				</div>
			</Card>

			<SectionTitle>移动端配对</SectionTitle>
			<Card>
				{!running ? (
					<div className="px-4 py-10 text-center text-label text-ink-faint">先启用同步服务，再进行配对</div>
				) : (
					<div className="p-6">
						{/* 核心双栏：左侧二维码聚焦，右侧配对说明与网络信息 */}
						<div className="flex flex-col items-center gap-8 md:flex-row md:items-center">
							{/* 左侧：纯白紧凑二维码 */}
							<div className="flex shrink-0 flex-col items-center">
								<div className="rounded-2xl bg-white p-4 shadow-md ring-1 ring-black/5">
									{code ? (
										<QRCodeSVG value={code} size={176} level="M" marginSize={0} />
									) : (
										<div className="flex h-[176px] w-[176px] items-center justify-center text-center text-label text-[#6e6e6e]">
											未检测到可用地址
										</div>
									)}
								</div>
								<div className="mt-3 flex items-center gap-1.5 text-detail font-medium text-ink-faint">
									<QrCode size={13} strokeWidth={2} />
									<span>使用手机 Lyra 扫码配对</span>
								</div>
							</div>

							{/* 右侧：纵向清晰指引与地址 */}
							<div className="min-w-0 flex-1 space-y-4">
								<div>
									<div className="flex items-center gap-2 text-label font-semibold text-ink">
										<Smartphone size={16} strokeWidth={2.2} className="text-info" />
										<span>两步快速绑定</span>
									</div>
									<ol className="mt-2.5 space-y-1.5">
										<Step index={1}>
											手机端打开 Lyra，点击首页右上角或连接页的 <Strong>「扫码」</Strong>。
										</Step>
										<Step index={2}>
											对准左侧二维码，即可瞬间完成端到端自动安全配对。
										</Step>
									</ol>
								</div>

								{/* 当前网络地址与切换 */}
								<div className="pt-2">
									<div className="flex items-center justify-between pb-2 text-detail">
										<span className="font-medium text-ink-faint">二维码当前指向的局域网地址</span>
										<button
											type="button"
											onClick={() => setRemoteOpen((open) => !open)}
											className="cursor-pointer text-info hover:underline"
										>
											{remoteOpen ? "收起高级网络配置" : "公网 / 中转代理配置"}
										</button>
									</div>
									<div className="flex flex-wrap gap-2">
										{routes.map((route) => {
											const key = keyOf(route);
											const on = active !== null && key === keyOf(active);
											return (
												<button
													key={key}
													type="button"
													onClick={() => setChosen(key)}
													className={`cursor-pointer rounded-lg border px-3 py-1.5 font-mono text-detail transition-all ${
														on
															? "border-info bg-info/10 font-semibold text-info shadow-xs"
															: "border-line bg-shell/40 text-ink-muted hover:border-ink-faint hover:bg-shell"
													}`}
												>
													{routeLabel(route)}
												</button>
											);
										})}
										{routes.length === 0 && <span className="text-detail text-ink-faint">未检测到可用地址</span>}
									</div>
								</div>
							</div>
						</div>

						{/* 公网与中转服务器展开区：独立抽屉式，不夹在主内容中间 */}
						<div className="ly-reveal" data-open={remoteOpen} aria-hidden={!remoteOpen}>
							<div>
								<div className="mt-5 space-y-3.5 rounded-xl border border-line bg-shell/60 p-4">
									<div className="text-detail font-medium text-ink">远程穿透与中转服务器</div>
									<RemoteField
										label="公网地址 / 反向代理"
										hint="已有域名或端口转发能打到这台电脑时填。留空则只用局域网。"
										placeholder="lyra.example.com 或 https://lyra.example.com:8443"
										value={publicDraft}
										onChange={setPublicDraft}
										onCommit={(next) =>
											void saveSettings({ ...settings, sync: { ...settings.sync, publicUrl: next } }).then(
												() => void refreshSync(),
											)
										}
									/>
									<RemoteField
										label="中转服务器"
										hint="两端都连不上对方时用。电脑和手机都主动连它，NAT 后面也能配对。"
										placeholder="relay.example.com 或 wss://relay.example.com:9000"
										value={relayDraft}
										onChange={setRelayDraft}
										onCommit={(next) =>
											void saveSettings({ ...settings, sync: { ...settings.sync, relayUrl: next } }).then(
												() => void refreshSync(),
											)
										}
									/>
								</div>
							</div>
						</div>

						<div className="mt-6 border-t border-line-soft pt-4">
							<button
								type="button"
								onClick={() => setManualOpen((open) => !open)}
								className="flex w-full cursor-pointer items-center justify-between text-label text-ink-muted transition-colors hover:text-ink"
							>
								无法扫描？查看手动连接信息与令牌
								<ChevronDown
									size={14}
									strokeWidth={2}
									className="transition-transform duration-[var(--ly-t-base)]"
									style={manualOpen ? { transform: "rotate(180deg)" } : undefined}
								/>
							</button>

							<div className="ly-reveal" data-open={manualOpen} aria-hidden={!manualOpen}>
								<div>
									<div className="mt-4 space-y-4">
										<div>
											<div className="mb-1.5 text-detail text-ink-faint">在手机上填写这个地址</div>
											<div className="flex items-center gap-2 rounded-[10px] border border-line bg-input px-3.5 py-2.5">
												<span className="min-w-0 flex-1 truncate font-mono text-label text-ink">
													{active ? routeLabel(active) : "未检测到可用地址"}
												</span>
											</div>
										</div>

										<div>
											<div className="mb-1.5 flex items-center gap-2">
												<span className="text-detail text-ink-faint">配对令牌</span>
												<GhostButton
													onClick={() => {
														void window.lyra.sync.rotateToken().then(() => void refreshSync());
													}}
												>
													<span className="flex items-center gap-1.5">
														<RotateCw size={11} strokeWidth={2} />
														重置
													</span>
												</GhostButton>
											</div>
											<div className="flex items-center gap-2 rounded-[10px] border border-line bg-input px-3.5 py-2.5">
												<span className="min-w-0 flex-1 truncate font-mono text-label text-ink">{sync?.token}</span>
												<CopyButton
													done={copied === "token"}
													onCopy={() => {
														void navigator.clipboard.writeText(sync?.token ?? "");
														setCopied("token");
														setTimeout(() => setCopied(null), 1500);
													}}
												/>
											</div>
										</div>

										{code && (
											<div>
												<div className="mb-1.5 text-detail text-ink-faint">
													配对链接，复制后在手机上粘贴也可以
												</div>
												<div className="flex items-center gap-2 rounded-[10px] border border-line bg-input px-3.5 py-2.5">
													<code className="min-w-0 flex-1 truncate font-mono text-detail text-ink-muted">{code}</code>
													<CopyButton
														done={copied === "code"}
														onCopy={() => {
															void navigator.clipboard.writeText(code);
															setCopied("code");
															setTimeout(() => setCopied(null), 1500);
														}}
													/>
												</div>
											</div>
										)}
									</div>
								</div>
							</div>
						</div>
					</div>
				)}
			</Card>
		</div>
	);
}

/** Identity for the picker: the label is what distinguishes one route from another on screen. */
function keyOf(route: PairingRoute): string {
	return `${route.kind}:${routeLabel(route)}`;
}

function Step({ index, children }: { index: number; children: React.ReactNode }) {
	return (
		<li className="flex gap-2.5">
			<span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-card text-detail font-medium text-ink-muted">
				{index}
			</span>
			<span className="text-label leading-relaxed text-ink-muted">{children}</span>
		</li>
	);
}

function Strong({ children }: { children: React.ReactNode }) {
	return <span className="font-medium text-ink">{children}</span>;
}

function CopyButton({ done, onCopy }: { done: boolean; onCopy: () => void }) {
	return (
		<button
			type="button"
			data-ly-tip={done ? "已复制" : "复制"}
			aria-label={done ? "已复制" : "复制"}
			onClick={onCopy}
			className="shrink-0 cursor-pointer text-ink-faint transition-colors hover:text-ink"
		>
			{done ? <Check size={14} strokeWidth={2} className="text-ok" /> : <Copy size={14} strokeWidth={1.8} />}
		</button>
	);
}

/**
 * An address field that only saves what can actually be used.
 *
 * Committed on blur rather than per keystroke — the value is written to settings and re-read by the
 * server, and doing that while someone is halfway through typing a hostname means the QR code
 * flickers through a dozen half-typed addresses. Invalid input is left in the box, unsaved, with
 * the reason under it; clearing the box is how you turn the route off.
 */
function RemoteField({
	label,
	hint,
	placeholder,
	value,
	onChange,
	onCommit,
}: {
	label: string;
	hint: string;
	placeholder: string;
	value: string;
	onChange: (next: string) => void;
	onCommit: (next: string) => void;
}) {
	const invalid = value.trim().length > 0 && parseEndpoint(value) === null;
	return (
		<div>
			<div className="mb-1.5 text-detail text-ink-muted">{label}</div>
			<TextInput
				value={value}
				onChange={onChange}
				mono
				invalid={invalid}
				placeholder={placeholder}
				onBlur={() => {
					if (!invalid) onCommit(value.trim());
				}}
			/>
			<div className={`mt-1 text-detail ${invalid ? "text-danger" : "text-ink-faint"}`}>
				{invalid ? "这个地址看不明白，检查一下拼写" : hint}
			</div>
		</div>
	);
}
