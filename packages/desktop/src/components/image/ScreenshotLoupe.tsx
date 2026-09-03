/**
 * The magnifier that follows the pointer before a region is chosen.
 *
 * Two jobs at once, and they are the same job. Blown up far enough to see individual pixels, it
 * says exactly which pixel the crosshair is on — which is what makes a selection land on a border
 * rather than one pixel inside it. And the pixel under the crosshair has a colour, so reading that
 * colour off is free: a capture tool is already the thing pointed at the screen, and every other
 * one of consequence lets you take a colour with it.
 *
 * Sampled from the frozen snapshot rather than from the live screen. The snapshot is what the
 * capture will contain, so what the loupe reports and what ends up in the file cannot disagree —
 * and it is already decoded, so this costs a `drawImage` of a few hundred pixels per frame.
 */

import { useLayoutEffect, useRef } from "react";
import type { Point } from "./screenshot-geometry.ts";

/** How many snapshot pixels are visible along each axis of the loupe (must be odd). */
const SPAN = 17;
/** Display size in CSS pixels for a single snapshot pixel inside the loupe. */
const CELL = 8;
/** The loupe glass size on screen (strictly integer: 17 * 8 = 136px, zero subpixel drift). */
const SIZE = SPAN * CELL;
const CENTER_CELL_OFFSET = Math.floor(SPAN / 2) * CELL; // 64px
const CENTER_LINE_OFFSET = CENTER_CELL_OFFSET + CELL / 2; // 68px

export interface LoupeReading {
	/** In snapshot pixels, which is what a colour picker's coordinates mean. */
	x: number;
	y: number;
	hex: string;
}

export function ScreenshotLoupe({
	source,
	at,
	scale,
	viewport,
	reading,
	copied,
}: {
	/** The frozen screen, at its own resolution. */
	source: HTMLCanvasElement | null;
	/** Where the pointer is, in CSS pixels. */
	at: Point;
	/** Snapshot pixels per CSS pixel. */
	scale: number;
	viewport: { width: number; height: number };
	reading: LoupeReading | null;
	copied: boolean;
}) {
	const glass = useRef<HTMLCanvasElement | null>(null);

	useLayoutEffect(() => {
		const el = glass.current;
		const ctx = el?.getContext("2d");
		if (!el || !ctx || !source) return;
		const targetX = reading ? reading.x : Math.round(at.x * scale);
		const targetY = reading ? reading.y : Math.round(at.y * scale);
		const half = Math.floor(SPAN / 2);
		ctx.imageSmoothingEnabled = false;
		// A slab of the snapshot, blown up so one snapshot pixel is a visible square.
		// Aligned strictly to integer snapshot pixels so the center box matches `reading` exactly.
		ctx.drawImage(source, targetX - half, targetY - half, SPAN, SPAN, 0, 0, el.width, el.height);
	}, [source, at.x, at.y, scale, reading]);

	/*
	 * Beside the pointer, and never off the screen.
	 *
	 * Flipped to the other side when it would overhang, which is what keeps it usable in the corner
	 * where a selection most often ends.
	 */
	const pad = 10;
	const boxW = SIZE;
	const boxH = SIZE + 44;
	const left = at.x + pad + boxW > viewport.width ? at.x - pad - boxW : at.x + pad;
	const top = at.y + pad + boxH > viewport.height ? at.y - pad - boxH : at.y + pad;
	const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

	return (
		<div
			data-loupe
			className="pointer-events-none absolute overflow-hidden rounded-lg border border-white/25 bg-black/80 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-sm"
			style={{ left, top, width: boxW }}
		>
			<div className="relative" style={{ height: SIZE }}>
				<canvas ref={glass} width={SIZE} height={SIZE} className="block h-full w-full" />
				{/*
				 * The crosshair and target box mark the exact integer pixel being sampled.
				 * Using strict integer pixel values avoids browser subpixel rounding jitter.
				 */}
				<span
					className="absolute inset-x-0 h-px bg-[var(--color-accent)]/90"
					style={{ top: CENTER_LINE_OFFSET }}
				/>
				<span
					className="absolute inset-y-0 w-px bg-[var(--color-accent)]/90"
					style={{ left: CENTER_LINE_OFFSET }}
				/>
				<span
					className="absolute border border-[var(--color-accent)] shadow-[0_0_2px_rgba(0,0,0,0.8)]"
					style={{
						left: CENTER_CELL_OFFSET,
						top: CENTER_CELL_OFFSET,
						width: CELL,
						height: CELL,
					}}
				/>
			</div>
			<div className="space-y-0.5 px-2 py-1.5 text-caption text-white/85 tabular-nums">
				<div className="flex items-center justify-between gap-2">
					<span className="text-white/50">坐标</span>
					<span className="font-mono">
						{reading ? `${reading.x}, ${reading.y}` : "—"}
					</span>
				</div>
				<div className="flex items-center justify-between gap-2">
					<span className="text-white/50">色值</span>
					<span className="flex items-center gap-1 font-mono">
						<span
							className="inline-block size-2.5 rounded-[2px] border border-white/30"
							style={{ background: reading?.hex ?? "transparent" }}
						/>
						{reading?.hex ?? "—"}
					</span>
				</div>
				<div className="pt-0.5 text-center text-white/45">{copied ? "已复制" : `按 ${isMac ? "⌘C" : "Ctrl+C"} 复制色值`}</div>
			</div>
		</div>
	);
}
