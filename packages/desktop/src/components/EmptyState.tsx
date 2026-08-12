import { Bug, Hammer, RefreshCw, Telescope } from "lucide-react";
import { Scroller } from "./Scroller.tsx";
import { Composer } from "./Composer.tsx";
import { useLayout } from "../layout.tsx";
import { useApp } from "../store.ts";

const CARDS = [
	{ icon: Telescope, tint: "text-info", label: "探索并理解代码", prompt: "帮我梳理这个项目的整体架构：入口在哪里、核心模块怎么划分、数据是怎么流动的。" },
	{ icon: Hammer, tint: "text-violet", label: "构建新功能、应用或工具", prompt: "我想新增一个功能，先帮我确认现有代码里应该改哪些文件，再给出实现方案。" },
	{ icon: RefreshCw, tint: "text-ok", label: "审查代码并提出修改建议", prompt: "审查当前工作区未提交的改动，指出其中的缺陷和风险，按严重程度排序。" },
	{ icon: Bug, tint: "text-accent", label: "修复问题和失败", prompt: "帮我定位一个问题的根因。先复现，再定位，最后给出最小改动的修复。" },
];

export function EmptyState() {
	const workspace = useApp((s) => s.workspace);
	const send = useApp((s) => s.send);
	const { compact } = useLayout();

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/*
			 * Scrolls rather than clips: at the minimum window height the mark, the heading and
			 * two rows of cards do not all fit, and a card you cannot reach is worse than one
			 * you have to scroll to.
			 */}
			<Scroller className="flex-1" contentClassName={`flex flex-col py-4 ${compact ? "px-4" : "px-8"}`}>
				{/*
				 * `m-auto` and not `justify-center`: a centred flex child that outgrows its
				 * parent gets clipped at the top with no way to scroll back up to it.
				 */}
				<div className="m-auto flex w-full flex-col items-center">
					<TerminalMark compact={compact} />

					<h1
						className={`mt-6 shrink-0 text-center leading-tight font-semibold tracking-tight text-balance text-ink ${
							compact ? "text-[21px]" : "text-[24px]"
						}`}
					>
						要在{" "}
						<span className="underline decoration-ink-faint decoration-dotted underline-offset-[6px]">
							{workspace?.name ?? "未选择项目"}
						</span>{" "}
						内开发什么？
					</h1>

					{/*
					 * Capped width, not fixed: a fluid grid meant collapsing the sidebar inflated
					 * every card, while a hard width overflowed a narrow window.
					 *
					 * The column count keys off this container rather than the window, because the
					 * sidebar takes its width out of the same budget — at 760pt with the sidebar
					 * open, four cards get 99px each and every label wraps to four lines. Below
					 * 4×120px they go two by two, which keeps 2×2 symmetry for the four of them.
					 */}
					<div
						className={`@container w-full max-w-[var(--dw-content)] shrink-0 ${compact ? "mt-6" : "mt-9"}`}
					>
						<div className="grid grid-cols-4 gap-2.5 @max-[510px]:grid-cols-2">
							{CARDS.map((card) => (
								<button
									key={card.label}
									type="button"
									onClick={() => void send([{ type: "text", text: card.prompt }])}
									className="group flex min-h-[72px] flex-col justify-between gap-2 rounded-[11px] border border-line bg-transparent p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-ink-faint/60 hover:bg-card/60 active:translate-y-0"
								>
									<card.icon size={17} strokeWidth={1.7} className={`shrink-0 ${card.tint}`} />
									<span className="text-[12.5px] leading-snug text-ink">{card.label}</span>
								</button>
							))}
						</div>
					</div>
				</div>
			</Scroller>

			<Composer />
		</div>
	);
}

/** The rounded-square terminal glyph from the reference empty state. */
function TerminalMark({ compact }: { compact: boolean }) {
	const size = compact ? 46 : 56;
	return (
		<svg width={size} height={size} viewBox="0 0 64 64" fill="none" className="shrink-0" aria-hidden>
			<rect
				x="6"
				y="10"
				width="52"
				height="44"
				rx="15"
				stroke="var(--color-ink-faint)"
				strokeWidth="2.4"
				opacity="0.75"
			/>
			<path
				d="M22 26l7 6-7 6"
				stroke="var(--color-ink-muted)"
				strokeWidth="2.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path d="M34 39h10" stroke="var(--color-ink-muted)" strokeWidth="2.6" strokeLinecap="round" />
		</svg>
	);
}
