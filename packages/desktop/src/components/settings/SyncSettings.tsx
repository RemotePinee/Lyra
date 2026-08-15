import { Copy, RotateCw, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../../store.ts";
import { Badge, Card, Field, GhostButton, Row, SectionTitle, TextInput, Toggle } from "./controls.tsx";

export function SyncSettings() {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const sync = useApp((s) => s.sync);
	const refreshSync = useApp((s) => s.refreshSync);
	const [port, setPort] = useState(String(settings?.sync.port ?? 4517));
	const [copied, setCopied] = useState(false);

	// Client count changes as the phone connects and disconnects.
	useEffect(() => {
		const timer = setInterval(() => void refreshSync(), 4000);
		return () => clearInterval(timer);
	}, [refreshSync]);

	if (!settings) return null;

	return (
		<div className="pt-8">
			<h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">移动端同步</h1>
			<p className="mt-2 max-w-[600px] pb-7 text-[13px] leading-relaxed text-ink-muted">
				手机连上以后可以查看正在进行的回合、批准操作、继续追问，两端内容完全一致。
			</p>

			<SectionTitle>服务</SectionTitle>
			<Card className="mb-6">
				<Row
					title="启用局域网同步"
					detail="仅在本机所在局域网监听，需要配对令牌才能访问。"
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
					title="状态"
					detail={sync?.running ? `${sync.clients} 个设备已连接` : "未运行"}
					control={<Badge tone={sync?.running ? "ok" : "muted"}>{sync?.running ? "运行中" : "已停止"}</Badge>}
				/>
				<div className="px-4 py-3.5">
					<Field label="端口">
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

			<SectionTitle>配对</SectionTitle>
			<Card>
				{!sync?.running ? (
					<div className="px-4 py-8 text-center text-[12.5px] text-ink-faint">先启用同步服务再进行配对</div>
				) : (
					<div className="space-y-4 p-4">
						<div>
							<div className="mb-1.5 text-[12.5px] text-ink-muted">局域网地址</div>
							<div className="space-y-1">
								{sync.addresses.map((address) => (
									<div key={address} className="font-mono text-[13px] text-ink">
										http://{address}:{sync.port}
									</div>
								))}
								{sync.addresses.length === 0 && (
									<div className="text-[12.5px] text-ink-faint">未检测到局域网地址</div>
								)}
							</div>
						</div>

						<div>
							<div className="mb-1.5 flex items-center gap-2">
								<span className="text-[12.5px] text-ink-muted">配对令牌</span>
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
								<span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{sync.token}</span>
								<button
									type="button"
									data-ly-tip="复制"
									onClick={() => {
										void navigator.clipboard.writeText(sync.token ?? "");
										setCopied(true);
										setTimeout(() => setCopied(false), 1500);
									}}
									className="shrink-0 text-ink-faint transition-colors hover:text-ink"
								>
									<Copy size={14} strokeWidth={1.8} />
								</button>
							</div>
							{copied && <div className="mt-1.5 text-[11.5px] text-ok">已复制</div>}
						</div>

						{sync.pairingUrl && (
							<div className="rounded-[10px] border border-line bg-shell/60 p-4">
								<div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-ink">
									<Smartphone size={13} strokeWidth={1.9} />
									在手机上打开 Lyra，输入下面的地址和令牌
								</div>
								<code className="block break-all font-mono text-[11.5px] text-ink-muted">{sync.pairingUrl}</code>
							</div>
						)}
					</div>
				)}
			</Card>
		</div>
	);
}
