import { useEffect, useRef, useState } from "react";
import { X, MessageSquare, ExternalLink } from "lucide-react";
import { useApp } from "../store.ts";
import type { SessionMeta } from "@lyra/core";

export function SessionTabBar() {
	const openTabs = useApp((s) => s.openTabs);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const sessions = useApp((s) => s.sessions);
	const switchTab = useApp((s) => s.switchTab);
	const closeTab = useApp((s) => s.closeTab);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	const activeTabRef = useRef<HTMLDivElement | null>(null);

	const [fadeLeft, setFadeLeft] = useState(false);
	const [fadeRight, setFadeRight] = useState(false);

	// Pointer-based drag state
	const [dragState, setDragState] = useState<{
		id: string;
		startX: number;
		startY: number;
		currentX: number;
		currentY: number;
		isDragging: boolean;
		isTornOff: boolean;
	} | null>(null);

	const dragStateRef = useRef(dragState);
	dragStateRef.current = dragState;

	const updateFade = () => {
		const el = scrollContainerRef.current;
		if (!el) return;
		const canScrollLeft = el.scrollLeft > 2;
		const canScrollRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
		setFadeLeft(canScrollLeft);
		setFadeRight(canScrollRight);
	};

	// Auto-scroll active tab into view when switched
	useEffect(() => {
		if (activeTabRef.current && !dragState?.isDragging) {
			activeTabRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
		}
		updateFade();
	}, [activeSessionId, openTabs, dragState?.isDragging]);

	useEffect(() => {
		const el = scrollContainerRef.current;
		if (!el) return;
		updateFade();

		let targetScrollLeft = el.scrollLeft;
		let rafId: number | null = null;

		const smoothScrollStep = () => {
			const diff = targetScrollLeft - el.scrollLeft;
			if (Math.abs(diff) > 0.5) {
				el.scrollLeft += diff * 0.16;
				updateFade();
				rafId = requestAnimationFrame(smoothScrollStep);
			} else {
				el.scrollLeft = targetScrollLeft;
				updateFade();
				rafId = null;
			}
		};

		const onWheel = (e: WheelEvent) => {
			if (e.deltaY !== 0 || e.deltaX !== 0) {
				e.preventDefault();
				const rawDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
				const delta = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta) * 0.75, 120);
				const maxScroll = el.scrollWidth - el.clientWidth;
				targetScrollLeft = Math.max(0, Math.min(maxScroll, targetScrollLeft + delta));

				if (rafId === null) {
					rafId = requestAnimationFrame(smoothScrollStep);
				}
			}
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			el.removeEventListener("wheel", onWheel);
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, [openTabs.length]);

	if (openTabs.length === 0) return null;

	const sessionMap = new Map<string, SessionMeta>();
	for (const s of sessions) {
		sessionMap.set(s.id, s);
	}

	const handleTearOff = (sessionId: string, screenX?: number, screenY?: number) => {
		const coords =
			screenX !== undefined && screenY !== undefined
				? `?x=${Math.round(screenX)}&y=${Math.round(screenY)}`
				: "";
		void window.lyra.system.openExternal(`lyra://session/${sessionId}${coords}`);
		void closeTab(sessionId);
	};

	const onPointerDownTab = (e: React.PointerEvent, id: string) => {
		if (e.button !== 0) return; // Only left button
		const target = e.target as HTMLElement;
		if (target.closest("button")) return; // Don't drag when clicking buttons

		// If current window is an auxiliary/detached window with only 1 tab (or main window with only 1 tab),
		// dragging the tab is disabled (standard browser behavior: a sole tab cannot be torn off from itself).
		const isSoleTab = openTabs.length <= 1;

		if (isSoleTab) {
			void switchTab(id);
			return;
		}

		// Capture all pointer events even outside window/bounds
		target.setPointerCapture(e.pointerId);

		setDragState({
			id,
			startX: e.clientX,
			startY: e.clientY,
			currentX: e.clientX,
			currentY: e.clientY,
			isDragging: false,
			isTornOff: false,
		});

		const onPointerMove = (moveEvt: PointerEvent) => {
			const current = dragStateRef.current;
			if (!current) return;

			const dx = moveEvt.clientX - current.startX;
			const dy = moveEvt.clientY - current.startY;
			const dist = Math.hypot(dx, dy);

			const isDragging = current.isDragging || dist > 4;

			// Tear off only when dragged downwards past the top bar (> 45px down)
			// or actually dragged well outside window boundaries
			const isOutsideWindow =
				moveEvt.clientX < -10 ||
				moveEvt.clientX > window.innerWidth + 10 ||
				moveEvt.clientY < -10 ||
				moveEvt.clientY > window.innerHeight + 10;
			const isTornOff = isDragging && (moveEvt.clientY > 45 || isOutsideWindow);

			if (isTornOff) {
				const session = sessionMap.get(id);
				const title = session?.title?.trim() || "新对话";
				// Move native ghost smoothly
				void window.lyra.system.dragGhost("move", { title });
			} else {
				void window.lyra.system.dragGhost("hide");
			}

			setDragState({
				...current,
				currentX: moveEvt.clientX,
				currentY: moveEvt.clientY,
				isDragging,
				isTornOff,
			});
		};

		const onPointerUp = (upEvt: PointerEvent) => {
			void window.lyra.system.dragGhost("destroy");
			try {
				target.releasePointerCapture(upEvt.pointerId);
			} catch {
				// Ignore if already released
			}
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);

			const final = dragStateRef.current;
			setDragState(null);

			if (!final) return;

			if (final.isTornOff) {
				handleTearOff(final.id, upEvt.screenX, upEvt.screenY);
			} else if (!final.isDragging) {
				void switchTab(final.id);
			}
		};

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerUp);
	};

	const draggingSession = dragState?.id ? sessionMap.get(dragState.id) : null;
	const draggingTitle = draggingSession?.title?.trim() || "新对话";

	return (
		<>
			<div
				ref={scrollContainerRef}
				onScroll={updateFade}
				style={{
					["--ly-fade-left" as string]: fadeLeft ? "18px" : "0px",
					["--ly-fade-right" as string]: fadeRight ? "18px" : "0px",
				}}
				className="ly-fade-edge no-drag flex h-full max-w-[calc(100vw-260px)] select-none items-center gap-1 overflow-x-auto no-scrollbar px-1 py-1"
			>
				{openTabs.map((id) => {
					const session = sessionMap.get(id);
					const isActive = activeSessionId === id;
					const isThisDragging = dragState?.id === id && dragState.isDragging;
					const title = session?.title?.trim() || "新对话";

					return (
						<div
							key={id}
							ref={isActive ? activeTabRef : null}
							role="tab"
							tabIndex={0}
							aria-selected={isActive}
							data-ly-tip={dragState?.isDragging ? undefined : title}
							data-ly-tip-side="bottom"
							onPointerDown={(e) => onPointerDownTab(e, id)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									void switchTab(id);
								}
							}}
							onAuxClick={(e) => {
								// Middle click to close tab
								if (e.button === 1) {
									e.preventDefault();
									e.stopPropagation();
									void closeTab(id);
								}
							}}
							className={`group relative flex h-7 shrink-0 max-w-[220px] min-w-[90px] select-none items-center justify-between gap-1.5 rounded-md px-2.5 text-xs transition-all ${
								openTabs.length > 1 ? (isThisDragging ? "cursor-grabbing opacity-30 scale-95 border border-dashed border-accent" : "cursor-grab") : "cursor-pointer"
							} ${
								isActive
									? "bg-elevated text-ink font-medium shadow-xs"
									: "text-ink-muted hover:bg-card-hover hover:text-ink"
							}`}
						>
							<div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden pointer-events-none">
								<MessageSquare size={13} className={`shrink-0 opacity-70 ${isActive ? "text-accent" : ""}`} />
								<span className="truncate">{title}</span>
							</div>

							<div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
								<button
									type="button"
									aria-label="独立窗口打开"
									data-ly-tip="独立窗口打开"
									data-ly-tip-side="bottom"
									onClick={(e) => {
										e.stopPropagation();
										handleTearOff(id);
									}}
									className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-ink-muted transition-all hover:bg-black/10 hover:text-ink dark:hover:bg-white/15"
								>
									<ExternalLink size={10} strokeWidth={2} />
								</button>

								<button
									type="button"
									aria-label="关闭标签页"
									onClick={(e) => {
										e.stopPropagation();
										void closeTab(id);
									}}
									className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-ink-muted transition-all hover:bg-black/10 hover:text-ink dark:hover:bg-white/15"
								>
									<X size={11} strokeWidth={2} />
								</button>
							</div>
						</div>
					);
				})}
			</div>

			{/* In-window drag ghost preview (only shown while moving inside the window) */}
			{dragState?.isDragging && !dragState.isTornOff && (
				<div
					style={{
						position: "fixed",
						left: dragState.currentX - 50,
						top: dragState.currentY - 14,
						pointerEvents: "none",
						zIndex: 9999,
					}}
					className="flex h-7 items-center gap-1.5 rounded-md px-3 text-xs shadow-xl backdrop-blur-md transition-colors border border-border/80 bg-elevated text-ink"
				>
					<MessageSquare size={13} className="shrink-0 opacity-70" />
					<span className="max-w-[140px] truncate font-medium">{draggingTitle}</span>
				</div>
			)}
		</>
	);
}
