/**
 * A plugin's mark.
 *
 * Uses the logo from the manifest when there is one. When there is not — which is most loose
 * skills and every MCP server — it draws a glyph that says what the thing *does*, on a tile
 * coloured from its name.
 *
 * It used to draw the first letter instead. A wall of lettered tiles is a wall of squares you
 * have to read: `A` tells you nothing about AgentFlow that the word "AgentFlow" sitting beside
 * it did not already tell you, and a page of them looks like a page of placeholders, because
 * that is what they are. A globe on a browser plugin and a terminal on a shell one are legible
 * before the eye reaches the label, which is the entire job of an icon in a grid.
 *
 * The glyph is guessed from the name, the category and what the bundle actually contains — see
 * `glyphFor`. Guessing wrong costs a slightly-off picture; the fallback is a puzzle piece, which
 * is at least honest about being a plugin of unknown shape.
 *
 * The colour is derived from the name rather than stored, so it survives a rename of the display
 * label and needs nothing written to disk. Hues are spaced around the wheel at one saturation and
 * lightness, so no entry shouts louder than its neighbours and the column still reads as one set.
 */

import {
	Blocks,
	Bot,
	Braces,
	Brain,
	Calendar,
	ChartNoAxesColumn,
	Cloud,
	Code,
	Container,
	Database,
	FileText,
	FolderOpen,
	GitBranch,
	Globe,
	Image,
	Mail,
	MessageSquare,
	Monitor,
	Music,
	Palette,
	Search,
	Server,
	ShieldCheck,
	Sparkles,
	Terminal,
	Wrench,
} from "lucide-react";

/**
 * Name or category fragment → glyph, first match wins.
 *
 * Ordered most specific first: `github` has to be tested before `git`, and `screenshot` before
 * `shot`, or the broader pattern swallows the narrower one. Matched against the lowercased name,
 * id and category joined together, so a bundle called "Chrome" and one categorised "Browser"
 * both land on the globe.
 *
 * The Chinese terms are there because our own categories are Chinese. Without them every bundle
 * in 思考 fell through to the fallback, which is the one case where a guess is cheap and being
 * right is free.
 */
const GLYPHS: [RegExp, typeof Globe][] = [
	[/browser|chrome|firefox|safari|webdriver|playwright|puppeteer|scrape|crawl|浏览器/, Globe],
	[/computer.?use|desktop|screen|gui|automation|applescript|macos|windows|本机|桌面/, Monitor],
	[/terminal|shell|bash|zsh|command.?line|\bcli\b|tmux|ssh|命令行/, Terminal],
	[/github|gitlab|pull.?request/, GitBranch],
	[/\bgit\b|version.?control|commit/, GitBranch],
	[/postgres|sqlite|mysql|mongo|redis|database|\bsql\b|query/, Database],
	[/file|filesystem|\bfs\b|directory|folder|storage|disk/, FolderOpen],
	[/docker|kubernetes|k8s|container|podman/, Container],
	[/aws|gcp|azure|cloud|s3|lambda|vercel|cloudflare/, Cloud],
	[/search|grep|find|index|retriev|rag\b/, Search],
	[/figma|design|palette|colou?r|theme|css|tailwind/, Palette],
	[/image|photo|picture|screenshot|png|jpe?g|vision|diagram/, Image],
	[/audio|music|sound|speech|voice|whisper|tts/, Music],
	[/mail|email|smtp|imap|gmail|inbox/, Mail],
	[/slack|discord|telegram|chat|message|notif/, MessageSquare],
	[/calendar|schedule|cron|reminder|meeting/, Calendar],
	[/chart|graph|metric|analytic|dashboard|stat/, ChartNoAxesColumn],
	[/doc|markdown|note|write|text|pdf|obsidian|notion|文档/, FileText],
	[/security|auth|secret|vault|credential|encrypt|scan/, ShieldCheck],
	[/\bapi\b|http|rest|graphql|webhook|json|schema/, Braces],
	[/server|mcp|proxy|relay|gateway|daemon/, Server],
	[/agent|assistant|\bbot\b/, Bot],
	[/memory|knowledge|brain|context|embed|思考|记忆/, Brain],
	[/model|\bllm\b|prompt|\bai\b|inference/, Sparkles],
	[/code|lint|compile|test|debug|refactor|review|开发|工程/, Code],
	[/tool|util|helper|kit/, Wrench],
];

export function PluginIcon({
	name,
	logo,
	brandColor,
	category,
	/** The bundle's own id, which is often more descriptive than its display name. */
	id,
	size = 32,
}: {
	name: string;
	logo?: string;
	brandColor?: string;
	category?: string;
	id?: string;
	size?: number;
}) {
	const radius = Math.round(size * 0.28);

	if (logo) {
		return (
			<img
				src={logo}
				alt=""
				width={size}
				height={size}
				style={{ borderRadius: radius }}
				className="shrink-0 object-cover"
			/>
		);
	}

	const hue = brandColor ? null : hueFor(name);
	const background = brandColor
		? `linear-gradient(145deg, ${brandColor}, color-mix(in srgb, ${brandColor} 68%, #000))`
		: `linear-gradient(145deg, hsl(${hue} 58% 56%), hsl(${(hue! + 32) % 360} 56% 44%))`;

	/*
	 * Its own name first, its category only as a fallback.
	 *
	 * One haystack put them in competition and the table's order decided, which is how Filesystem
	 * — categorised 本机 — ended up wearing a monitor: the category matched a rule listed above the
	 * one its own name would have matched. A name is more specific than the shelf it sits on, and
	 * the shelf is only worth asking about when the name said nothing.
	 */
	const Glyph = glyphFor(`${name} ${id ?? ""}`) ?? glyphFor(category ?? "") ?? Blocks;

	return (
		<span
			aria-hidden
			style={{ width: size, height: size, borderRadius: radius, background }}
			className="flex shrink-0 items-center justify-center text-white select-none"
		>
			<Glyph size={Math.round(size * 0.5)} strokeWidth={1.9} />
		</span>
	);
}

/** Null rather than the fallback, so the caller can try a second, weaker haystack. */
function glyphFor(haystack: string): typeof Globe | null {
	const text = haystack.toLowerCase();
	for (const [pattern, glyph] of GLYPHS) if (pattern.test(text)) return glyph;
	return null;
}

/**
 * A stable hue from a name.
 *
 * FNV-1a rather than a sum of char codes: the sum collides on anagrams, which is exactly what
 * near-identical plugin names tend to be (`fs-tools` and `tools-fs`).
 */
function hueFor(name: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		hash ^= name.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return Math.abs(hash) % 360;
}
