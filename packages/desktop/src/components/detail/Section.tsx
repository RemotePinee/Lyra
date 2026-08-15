/**
 * A labelled block inside an expanded card.
 *
 * One definition, used by the transcript's tool cards and by both panels. They had drifted into
 * three slightly different looks — different padding, different label size, monospace applied to
 * prose — which is the sort of difference nobody can name but everybody sees.
 *
 * `mono` rather than always-monospace: a command, a JSON argument and a program's output are code
 * and read better as code; a question someone typed is not, and setting it in a terminal face makes
 * the panel look like a log of machine noise rather than a record of a conversation.
 */

export function Section({
	title,
	mono = false,
	tone = "muted",
	children,
}: {
	title: string;
	mono?: boolean;
	tone?: "muted" | "ink" | "danger";
	children: React.ReactNode;
}) {
	const colour = tone === "danger" ? "text-danger/90" : tone === "ink" ? "text-ink" : "text-ink-muted";
	return (
		<div className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
			<div className="mb-1.5 text-[10.5px] tracking-wide text-ink-faint uppercase">{title}</div>
			<div
				className={`text-[11.5px] leading-relaxed break-words whitespace-pre-wrap ${colour} ${
					mono ? "font-mono" : ""
				}`}
			>
				{children}
			</div>
		</div>
	);
}
