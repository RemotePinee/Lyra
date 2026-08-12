import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { useState } from "react";

/** Section heading above a card group, as used by the reference settings pages. */
export function SectionTitle({ children }: { children: React.ReactNode }) {
	return <h2 className="mb-3 text-[15px] font-medium text-ink">{children}</h2>;
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
					<div className="text-[13.5px] text-ink">{title}</div>
					{detail && <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">{detail}</div>}
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
			<span className="mb-1.5 block text-[12.5px] text-ink-muted">{label}</span>
			{children}
			{hint && <span className="mt-1.5 block text-[11.5px] text-ink-faint">{hint}</span>}
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

export function Select<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string }[];
}) {
	return (
		<div className="relative">
			<select
				value={value}
				onChange={(e) => onChange(e.target.value as T)}
				className="h-[38px] w-full appearance-none rounded-[10px] border border-line bg-input pr-9 pl-3.5 text-[13px] text-ink focus:border-ink-faint"
			>
				{options.map((option) => (
					<option key={option.value} value={option.value} className="bg-elevated">
						{option.label}
					</option>
				))}
			</select>
			<ChevronDown
				size={15}
				strokeWidth={1.9}
				className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-faint"
			/>
		</div>
	);
}

/** Compact inline dropdown used in setting rows, matching the reference "Zed ˅" control. */
export function InlineSelect<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string }[];
}) {
	return (
		<div className="relative">
			<select
				value={value}
				onChange={(e) => onChange(e.target.value as T)}
				className="h-[30px] appearance-none rounded-lg border border-line bg-card pr-8 pl-3 text-[12.5px] text-ink transition-colors hover:border-ink-faint focus:border-ink-faint"
			>
				{options.map((option) => (
					<option key={option.value} value={option.value} className="bg-elevated">
						{option.label}
					</option>
				))}
			</select>
			<ChevronDown
				size={13}
				strokeWidth={1.9}
				className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-faint"
			/>
		</div>
	);
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			onClick={() => onChange(!checked)}
			className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 ${
				checked ? "bg-[#0a84ff]" : "bg-[#3a3a3a]"
			}`}
		>
			<span
				className="absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-[left] duration-200"
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

export function GhostButton({
	children,
	onClick,
	tone = "default",
	disabled,
}: {
	children: React.ReactNode;
	onClick: () => void;
	tone?: "default" | "danger";
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={`h-[26px] rounded-lg border border-line px-2.5 text-[12px] transition-colors disabled:opacity-45 ${
				tone === "danger"
					? "text-danger hover:border-danger/50 hover:bg-danger/10"
					: "text-ink-muted hover:border-ink-faint hover:text-ink"
			}`}
		>
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
