import type { LucideIcon } from "lucide-react";

/**
 * The middle of an empty panel body.
 *
 * Centred icon, name, one sentence saying what this is. The same shape for every kind of tab,
 * so the panel reads as one thing with several contents rather than as several unrelated
 * screens that happen to share a frame.
 *
 * Its own file because both the panel shell and the things inside it need it, and having the
 * shell export it made the two import each other.
 */
export function PanelEmpty({
	icon: Icon,
	title,
	children,
}: {
	icon: LucideIcon;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-7 pb-6 text-center">
			<Icon size={30} strokeWidth={1.35} className="text-ink-faint" />
			<h2 className="mt-3.5 text-[15.5px] font-medium text-ink">{title}</h2>
			<p className="mt-2 max-w-[290px] text-[12.5px] leading-relaxed text-ink-muted">{children}</p>
		</div>
	);
}
