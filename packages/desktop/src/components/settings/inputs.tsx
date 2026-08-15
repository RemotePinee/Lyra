/**
 * The controls you type into or pick from.
 *
 * The dropdown is a popover rather than a native `<select>`: the native one draws its own list
 * with the system's fonts and colours, which on macOS is a panel that belongs to another program.
 * Everything else here exists so that a text field, a secret and a choice read as one family
 * rather than three.
 */

import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { MenuItem, Popover, usePopover } from "../Popover.tsx";

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
				data-dw-tip={visible ? "隐藏" : "显示"}
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
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
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
				<span className="flex min-w-0 items-center gap-2">
					{current?.icon}
					<span className="min-w-0 truncate">{current?.label ?? value}</span>
				</span>
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
								icon={option.icon}
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
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
}) {
	return <Dropdown {...props} size="field" />;
}

/** Compact inline dropdown used in setting rows, matching the reference "Zed ˅" control. */
export function InlineSelect<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
}) {
	return <Dropdown {...props} size="inline" />;
}
