import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { MenuItem, Popover, usePopover } from "../Popover.tsx";
import { Text } from "../Text.tsx";

/** Section heading above a card group, as used by the reference settings pages. */
export function SectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<Text as="h2" size="title" weight="medium" className="mb-3">
			{children}
		</Text>
	);
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
	return <div className={`overflow-hidden rounded-[12px] border border-line bg-card/40 ${className}`}>{children}</div>;
}

/** One labelled row inside a card, with the control right-aligned. */
export function Row({
	title,
	detail,
	control,
	children,
}: {
	title: string;
	detail?: React.ReactNode;
	control?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<div className="border-b border-line-soft px-4 py-3.5 last:border-b-0">
			<div className="flex items-start gap-4">
				<div className="min-w-0 flex-1">
					<Text as="div" size="body">
						{title}
					</Text>
					{detail && (
						<Text as="div" size="label" tone="muted" className="mt-0.5 leading-relaxed">
							{detail}
						</Text>
					)}
				</div>
				{control && <div className="shrink-0 pt-0.5">{control}</div>}
			</div>
			{children}
		</div>
	);
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<label className="block">
			<Text size="label" tone="muted" className="mb-1.5 block">
				{label}
			</Text>
			{children}
			{hint && (
				<Text size="detail" tone="faint" className="mt-1.5 block">
					{hint}
				</Text>
			)}
		</label>
	);
}

export function TextInput({
	value,
	onChange,
	placeholder,
	mono,
	invalid,
	className = "",
	...rest
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	mono?: boolean;
	invalid?: boolean;
	className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className">) {
	return (
		<input
			{...rest}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			className={`h-[38px] rounded-[10px] border bg-input px-3.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-ink-faint ${
				invalid ? "border-danger/60" : "border-line"
			} ${mono ? "font-mono text-[12.5px]" : ""} ${className || "w-full"}`}
		/>
	);
}

export function SecretInput({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="relative">
			<input
				type={visible ? "text" : "password"}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				spellCheck={false}
				autoComplete="off"
				className="h-[38px] w-full rounded-[10px] border border-line bg-input pr-10 pl-3.5 text-[13px] tracking-wide text-ink placeholder:text-ink-faint focus:border-ink-faint"
			/>
			<button
				type="button"
				title={visible ? "隐藏" : "显示"}
				onClick={() => setVisible((v) => !v)}
				className="absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-faint transition-colors hover:text-ink"
			>
				{visible ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
			</button>
		</div>
	);
}

/**
 * A dropdown, built from the app's own popover rather than from `<select>`.
 *
 * The native control was the last thing here drawing itself with the platform's widgets: its
 * list is rendered by the OS, so it ignores the theme, the type scale and the corner radii, and
 * on macOS it opens as a panel that overlaps its own trigger. Everything else in the app that
 * offers a list of choices already goes through `Popover` — the model picker, the effort picker,
 * the branch menu — so this one does too, and inherits their keyboard handling and dismissal.
 */
function Dropdown<T extends string>({
	value,
	onChange,
	options,
	size,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string }[];
	/** `field` fills a form row; `inline` is the compact one that sits at the end of a setting. */
	size: "field" | "inline";
}) {
	const menu = usePopover();
	const current = options.find((option) => option.value === value);
	const field = size === "field";

	return (
		<>
			<button
				type="button"
				onClick={menu.toggle}
				aria-haspopup="listbox"
				aria-expanded={menu.open}
				className={`flex items-center justify-between gap-2 border text-ink transition-colors ${
					field
						? "h-[38px] w-full rounded-[10px] border-line bg-input px-3.5 text-[13px]"
						: "h-[30px] rounded-lg border-line bg-card px-3 text-[12.5px]"
				} ${menu.open ? "border-ink-faint" : "hover:border-ink-faint"}`}
			>
				<span className="min-w-0 truncate">{current?.label ?? value}</span>
				<ChevronDown
					size={field ? 15 : 13}
					strokeWidth={1.9}
					className="shrink-0 text-ink-faint transition-transform duration-150"
					style={menu.open ? { transform: "rotate(180deg)" } : undefined}
				/>
			</button>

			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width={220}>
					<div className="p-1">
						{options.map((option) => (
							<MenuItem
								key={option.value}
								selected={option.value === value}
								detail={option.detail}
								onClick={() => {
									onChange(option.value);
									menu.close();
								}}
							>
								{option.label}
							</MenuItem>
						))}
					</div>
				</Popover>
			)}
		</>
	);
}

export function Select<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string }[];
}) {
	return <Dropdown {...props} size="field" />;
}

/** Compact inline dropdown used in setting rows, matching the reference "Zed ˅" control. */
export function InlineSelect<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string }[];
}) {
	return <Dropdown {...props} size="inline" />;
}

/**
 * The switch used by every boolean setting.
 *
 * Both colours came from a hard-coded pair — an iOS blue and a dark grey — so it ignored the
 * accent the user picked and, on a light theme, showed a near-black track for "off" against a
 * pale card. The track now follows the theme in both states, and the knob reuses `.dw-knob`,
 * which is the same treatment the appearance sliders use: white with a hairline and a shadow so
 * it stays visible on a pale track, lightened on dark so it does not glare.
 */
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			onClick={() => onChange(!checked)}
			className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 ${
				checked ? "bg-accent" : "bg-line"
			}`}
		>
			<span
				className="dw-knob absolute top-[3px] h-4 w-4 rounded-full border transition-[left] duration-200"
				style={{ left: checked ? 19 : 3 }}
			/>
		</button>
	);
}

export function Segmented<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string }[];
}) {
	return (
		<div className="flex gap-0.5 rounded-lg bg-card p-0.5">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					onClick={() => onChange(option.value)}
					className={`h-[26px] rounded-md px-3 text-[12.5px] transition-colors ${
						value === option.value ? "bg-elevated text-ink" : "text-ink-muted hover:text-ink"
					}`}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function Badge({ tone, children }: { tone: "ok" | "muted" | "danger" | "accent"; children: React.ReactNode }) {
	const tones = {
		ok: "bg-ok/15 text-ok",
		muted: "bg-card text-ink-faint",
		danger: "bg-danger/15 text-danger",
		accent: "bg-accent/15 text-accent",
	};
	return (
		<span className={`rounded-full px-2 py-0.5 text-[11.5px] leading-[18px] ${tones[tone]}`}>{children}</span>
	);
}

/**
 * The outlined button every settings page uses for a secondary action.
 *
 * Laid out as a flex row so an icon can sit beside the label — three pages had copied the class
 * list verbatim rather than use this, and one of them had drifted: a different height, and a
 * press animation the others did not have.
 */
export function GhostButton({
	children,
	icon,
	onClick,
	tone = "default",
	disabled,
	title,
}: {
	children: React.ReactNode;
	icon?: React.ReactNode;
	onClick: () => void;
	tone?: "default" | "danger";
	disabled?: boolean;
	title?: string;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			title={title}
			className={`flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12px] transition-colors duration-150 disabled:opacity-45 disabled: ${
				tone === "danger"
					? "text-danger hover:border-danger/50 hover:bg-danger/10"
					: "text-ink-muted hover:border-ink-faint hover:text-ink"
			}`}
		>
			{icon}
			{children}
		</button>
	);
}

export function PrimaryButton({
	children,
	onClick,
	disabled,
}: {
	children: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className="h-[32px] rounded-lg bg-ink px-3.5 text-[12.5px] font-medium text-shell transition-opacity hover:opacity-90 disabled:opacity-40"
		>
			{children}
		</button>
	);
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
	return <p className="px-4 py-10 text-center text-[12.5px] leading-relaxed text-ink-faint">{children}</p>;
}
