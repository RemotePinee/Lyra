import { ChevronDown, ChevronUp, Copy, Globe, QrCode, RotateCw, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../store.ts";
import { Badge, Card, Field, GhostButton, Row, SectionTitle, TextInput, Toggle } from "./controls.tsx";

export function SyncSettings() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const sync = useApp((s) => s.sync);
	const refreshSync = useApp((s) => s.refreshSync);
	const [port, setPort] = useState(String(settings?.sync.port ?? 4517));
	const [copiedToken, setCopiedToken] = useState(false);
	const [copiedUrl, setCopiedUrl] = useState(false);
	const [manualOpen, setManualOpen] = useState(false);

	// Address selection for QR Code generation
	const [selectedHost, setSelectedHost] = useState<string>("");
	const [customHost, setCustomHost] = useState<string>("");
	const [useCustom, setUseCustom] = useState(false);

	// Client count changes as the phone connects and disconnects.
	useEffect(() => {
		const timer = setInterval(() => void refreshSync(), 4000);
		return () => clearInterval(timer);
	}, [refreshSync]);

	// Initialize selected host once addresses are available
	useEffect(() => {
		if (sync?.addresses && sync.addresses.length > 0 && !selectedHost) {
			setSelectedHost(sync.addresses[0]);
		}
	}, [sync?.addresses, selectedHost]);

	// Computed active pairing URL based on selected address / custom host
	const activePairingUrl = useMemo(() => {
		if (!sync?.token) return null;
		const targetHost = useCustom ? customHost.trim() : (selectedHost || sync?.addresses[0] || "127.0.0.1");
		if (!targetHost) return sync.pairingUrl;

		// Clean up user custom input (strip protocol/port if already typed)
		const clean = targetHost.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
		const customPortMatch = /:(\d+)$/.exec(clean);
		const effectiveHost = clean.replace(/:\d+$/, "");
		const effectivePort = customPortMatch ? customPortMatch[1] : sync.port;

		return `lyra://pair?host=${effectiveHost}&port=${effectivePort}&token=${sync.token}`;
	}, [sync?.token, sync?.port, sync?.pairingUrl, sync?.addresses, useCustom, customHost, selectedHost]);

	if (!settings) return null;

	return (
		<div className="pt-8 max-w-[760px]">
			<h1 className="text-display leading-tight font-semibold tracking-tight text-ink">移动端同步</h1>
			<p className="mt-2 pb-7 text-label leading-relaxed text-ink-muted">
				手机与桌面端实时同步：随时查看正在进行的回合、批准操作、继续追问，两端状态毫秒级响应。
			</p>

			<SectionTitle>服务</SectionTitle>
			<Card className="mb-6">
				<Row
					title="启用同步服务"
					detail="在局域网启动 HTTP 与 WebSocket 同步服务，需安全令牌配对后方可访问。"
					control={
						<Toggle
							checked={sync?.running ?? settings.sync.enabled}
							onChange={(on) => {
								void (on ? window.lyra.sync.start() : window.lyra.sync.stop()).then(() => void refreshSync());
							}}
						/>
					}
				/>
				<Row
					title="服务状态"
					detail={sync?.running ? `${sync.clients} 个设备正在同步中` : "服务已停止"}
					control={<Badge tone={sync?.running ? "ok" : "muted"}>{sync?.running ? "运行中" : "已停止"}</Badge>}
				/>
				<div className="px-4 py-3.5">
					<Field label="监听端口">
						<div className="flex gap-2">
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
						</div>
					</Field>
				</div>
			</Card>

			<SectionTitle>移动端配对</SectionTitle>
			<Card>
				{!sync?.running ? (
					<div className="px-4 py-10 text-center">
						<div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-input text-ink-faint">
							<Smartphone size={20} strokeWidth={1.8} />
						</div>
						<div className="text-label font-medium text-ink-muted">同步服务未启动</div>
						<div className="mt-1 text-detail text-ink-faint">请在上方开启「启用同步服务」以生成配对二维码。</div>
					</div>
				) : (
					<div>
						{/* Main QR Section with Modern Side-by-Side Card Layout */}
						<div className="p-5 sm:p-6">
							<div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
								{/* Premium QR Surface */}
								<div className="flex flex-col items-center shrink-0">
									<div className="relative flex items-center justify-center rounded-2xl border border-line bg-white p-3.5 shadow-sm ring-4 ring-black/5 dark:ring-white/5">
										{activePairingUrl && (
											<QRCodeSVG
												value={activePairingUrl}
												size={160}
												level="M"
												includeMargin={false}
											/>
										)}
									</div>
									<div className="mt-2.5 flex items-center gap-1.5 text-caption text-ink-faint">
										<QrCode size={12} strokeWidth={2} />
										<span>使用手机 Lyra 扫码</span>
									</div>
								</div>

								{/* Guide & Source Selector */}
								<div className="flex min-w-0 flex-1 flex-col justify-center">
									<div className="space-y-3.5">
										<div className="flex items-center gap-2 text-label font-semibold text-ink">
											<Smartphone size={16} strokeWidth={2} className="text-accent" />
											手机一键扫码连接
										</div>

										<div className="space-y-1.5 text-detail leading-relaxed text-ink-muted">
											<div className="flex items-start gap-2">
												<span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-elevated font-mono text-[11px] font-medium text-ink">1</span>
												<span>打开手机端 Lyra，在「连接桌面端」页面点击顶部 <strong className="text-ink font-medium">「扫码连接」</strong>。</span>
											</div>
											<div className="flex items-start gap-2">
												<span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-elevated font-mono text-[11px] font-medium text-ink">2</span>
												<span>对准左侧二维码，即可自动识别协议并完成安全配对。</span>
											</div>
										</div>

										{/* Address Source Selector */}
										<div className="pt-1.5">
											<div className="mb-2 flex items-center justify-between text-caption text-ink-faint">
												<span>二维码配对地址源</span>
												<button
													type="button"
													onClick={() => setUseCustom(!useCustom)}
													className="text-accent hover:underline"
												>
													{useCustom ? "使用局域网 IP" : "使用公网反代 / 自定义域名"}
												</button>
											</div>

											{!useCustom ? (
												<div className="flex flex-wrap gap-1.5">
													{sync.addresses.map((addr) => {
														const isSelected = (selectedHost || sync.addresses[0]) === addr;
														return (
															<button
																key={addr}
																type="button"
																onClick={() => setSelectedHost(addr)}
																className={`rounded-lg px-2.5 py-1 font-mono text-[12px] transition-all ${
																	isSelected
																		? "bg-accent/20 font-medium text-accent border border-accent/30"
																		: "bg-input/60 text-ink-muted hover:bg-input hover:text-ink"
																}`}
															>
																{addr}:{sync.port}
															</button>
														);
													})}
													{sync.addresses.length === 0 && (
														<span className="text-detail text-ink-faint">未检测到局域网 IP</span>
													)}
												</div>
											) : (
												<div className="space-y-1.5">
													<div className="relative w-full">
														<Globe size={13} className="absolute left-3 top-3 text-ink-faint" />
														<TextInput
															value={customHost}
															onChange={setCustomHost}
															placeholder="输入域名或 IP (如 remote.example.com:4517)"
															className="w-full pl-8 text-detail"
														/>
													</div>
													<div className="text-caption text-ink-faint">
														支持包含反向代理端口，二维码将根据输入的地址动态更新。
													</div>
												</div>
											)}
										</div>
									</div>
								</div>
							</div>
						</div>

						{/* Collapsible Manual Connection Section */}
						<div className="border-t border-line-soft">
							<button
								type="button"
								onClick={() => setManualOpen(!manualOpen)}
								className="flex w-full items-center justify-between px-5 py-3 text-detail text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
							>
								<span>无法扫码？查看手动连接信息与令牌</span>
								{manualOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
							</button>

							{manualOpen && (
								<div className="space-y-4 bg-shell/40 px-5 pb-5 pt-2">
									<div>
										<div className="mb-1.5 flex items-center justify-between">
											<span className="text-caption text-ink-muted">配对令牌 (Token)</span>
											<GhostButton
												onClick={() => {
													void window.lyra.sync.rotateToken().then(() => void refreshSync());
												}}
											>
												<span className="flex items-center gap-1.5 text-caption">
													<RotateCw size={11} strokeWidth={2} />
													重置令牌
												</span>
											</GhostButton>
										</div>
										<div className="flex items-center gap-2 rounded-xl border border-line bg-input px-3.5 py-2">
											<span className="min-w-0 flex-1 truncate font-mono text-detail text-ink">{sync.token}</span>
											<button
												type="button"
												data-ly-tip="复制令牌"
												onClick={() => {
													void navigator.clipboard.writeText(sync.token ?? "");
													setCopiedToken(true);
													setTimeout(() => setCopiedToken(false), 1500);
												}}
												className="shrink-0 text-ink-faint transition-colors hover:text-ink"
											>
												<Copy size={13} strokeWidth={1.8} />
											</button>
										</div>
										{copiedToken && <div className="mt-1 text-caption text-ok">令牌已复制到剪贴板</div>}
									</div>

									{activePairingUrl && (
										<div>
											<div className="mb-1 text-caption text-ink-muted">完整配对链接</div>
											<div className="flex items-center gap-2 rounded-xl border border-line bg-input px-3.5 py-2">
												<code className="min-w-0 flex-1 truncate font-mono text-caption text-ink-muted">
													{activePairingUrl}
												</code>
												<button
													type="button"
													data-ly-tip="复制完整链接"
													onClick={() => {
														void navigator.clipboard.writeText(activePairingUrl);
														setCopiedUrl(true);
														setTimeout(() => setCopiedUrl(false), 1500);
													}}
													className="shrink-0 text-ink-faint transition-colors hover:text-ink"
												>
													<Copy size={13} strokeWidth={1.8} />
												</button>
											</div>
											{copiedUrl && <div className="mt-1 text-caption text-ok">配对链接已复制到剪贴板</div>}
										</div>
									)}
								</div>
							)}
						</div>
					</div>
				)}
			</Card>
		</div>
	);
}
