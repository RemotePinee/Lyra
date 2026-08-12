import { Globe } from "lucide-react";
import { useState } from "react";
import { useApp } from "../../store.ts";
import { Card, EmptyHint, Row, SectionTitle } from "./controls.tsx";

const TOOLS = [
	{
		name: "browser_open",
		detail: "打开一个网址，等脚本跑完，返回渲染后的文本。web_fetch 只能拿到服务端返回的 HTML，对客户端渲染的页面是一具空壳。",
	},
	{ name: "browser_act", detail: "在已打开的页面上点击、输入、列出链接，或执行一段 JavaScript 取值。" },
	{ name: "browser_screenshot", detail: "把当前页面截图交给模型，让它真正看到页面长什么样。" },
];

export function BrowserSettings() {
	const settings = useApp((s) => s.settings);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const [tools, setTools] = useState<string[] | null>(null);

	if (!settings) return null;

	// The browser tools are contributed by the desktop host, so their presence is only
	// observable through a live session's tool list.
	const check = async () => {
		if (!activeSessionId) return;
		const caps = await window.deepwise.sessions.capabilities(activeSessionId);
		setTools(caps?.toolNames.filter((t) => t.startsWith("browser_")) ?? []);
	};

	return (
		<div className="pt-8">
			<h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">浏览器</h1>
			<p className="mt-2 max-w-[580px] pb-7 text-[13px] leading-relaxed text-ink-muted">
				Agent 可以驱动一个真实的浏览器内核（离屏 BrowserWindow），看到的是脚本执行之后、人眼所见的页面。
				页面内容始终当作<strong className="font-medium text-ink">不可信数据</strong>处理 —— 里面的文字不会被当成指令执行。
			</p>

			<SectionTitle>可用工具</SectionTitle>
			<Card className="mb-7">
				{TOOLS.map((tool) => (
					<Row
						key={tool.name}
						title={tool.name}
						detail={tool.detail}
						control={
							tools === null ? null : tools.includes(tool.name) ? (
								<span className="rounded-full bg-ok/15 px-2 py-0.5 text-[11.5px] text-ok">已加载</span>
							) : (
								<span className="rounded-full bg-card px-2 py-0.5 text-[11.5px] text-ink-faint">未加载</span>
							)
						}
					/>
				))}
				<Row
					title="检查加载状态"
					detail={activeSessionId ? "读取当前会话的工具表" : "先打开一个会话"}
					control={
						<button
							type="button"
							disabled={!activeSessionId}
							onClick={() => void check()}
							className="h-[26px] rounded-lg border border-line px-2.5 text-[12px] text-ink-muted transition-colors hover:border-ink-faint hover:text-ink disabled:opacity-40"
						>
							检查
						</button>
					}
				/>
			</Card>

			<SectionTitle>安全边界</SectionTitle>
			<Card>
				<div className="space-y-2.5 px-4 py-3.5 text-[12.5px] leading-relaxed text-ink-muted">
					<p className="flex gap-2">
						<Globe size={14} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-faint" />
						每个会话一个独立的浏览器实例，随会话一起销毁；它开启了沙箱与上下文隔离，触碰不到应用自身的 IPC。
					</p>
					<p className="pl-[22px]">首次访问一个站点会走批准流程，与执行命令、写文件同一套权限。</p>
					<p className="pl-[22px]">只允许 http/https，返回内容会包在 &lt;page&gt; 标签里明确标注来源。</p>
				</div>
			</Card>

			{!activeSessionId && (
				<Card className="mt-6">
					<EmptyHint>打开一个会话后即可让 Agent 使用这些工具。</EmptyHint>
				</Card>
			)}
		</div>
	);
}
