/**
 * One bundle in the catalogue.
 *
 * A card, not a settings row: a mark, a name, one line about what it does, and nothing else on
 * the surface. Everything that could be done to it lives behind the ⋯, which is what keeps a
 * grid of twenty of these readable — a row with a toggle, a version, a source badge and two links
 * on it is a form, and a page of forms cannot be skimmed. What you already have is said once, in
 * the corner, because that is the only fact you are scanning for.
 */

import { Check, Download, ExternalLink, FolderOpen, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

import { MenuItem, Popover, usePopover } from "../Popover.tsx";
import { PluginIcon } from "../settings/PluginIcon.tsx";
import type { CatalogItem } from "./useCatalog.ts";

export function CatalogCard({
	item,
	onChanged,
	onError,
}: {
	item: CatalogItem;
	/** Something on disk moved; the catalogue has to be re-read. */
	onChanged: () => void;
	onError: (message: string) => void;
}) {
	const menu = usePopover();
	const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);

	const installed = item.installed !== null;

	const install = async () => {
		if (!item.entry) return;
		setBusy("install");
		const result = await window.lyra.plugins.installFromRegistry(item.entry);
		setBusy(null);
		if (result.ok) onChanged();
		else onError(`${item.name}：${result.message}`);
	};

	const uninstall = async () => {
		setBusy("uninstall");
		await window.lyra.plugins.uninstall(item.id);
		setBusy(null);
		onChanged();
	};

	return (
		<div className="group/card relative flex items-start gap-3 rounded-xl p-3 transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover/60">
			<PluginIcon name={item.name} logo={item.logo} brandColor={item.brandColor} size={36} />

			<div className="min-w-0 flex-1 pt-0.5">
				<div className="flex items-center gap-2">
					<span className="truncate text-label font-medium text-ink">{item.name}</span>
					{installed && (
						<span
							data-ly-tip={item.installed?.enabled ? undefined : "已安装，但在设置里被停用了"}
							className={`flex shrink-0 items-center gap-1 text-caption ${
								item.installed?.enabled ? "text-ok" : "text-ink-faint"
							}`}
						>
							<Check size={11} strokeWidth={2.4} />
							{item.installed?.enabled ? "已安装" : "已停用"}
						</span>
					)}
				</div>
				<p className="mt-0.5 line-clamp-2 text-detail leading-relaxed text-ink-muted">
					{item.description || "（没有描述）"}
				</p>
			</div>

			{/*
			 * Install is the one action worth a button of its own — it is why the page exists, and
			 * burying the only thing a visitor came to do inside a ⋯ would be a puzzle. Once it is
			 * installed there is no primary action left, so the space goes back to the description.
			 */}
			<div className="flex shrink-0 items-center gap-0.5 pt-0.5">
				{!installed && item.entry && (
					<button
						type="button"
						disabled={busy !== null}
						onClick={() => void install()}
						className="flex h-[26px] items-center gap-1.5 rounded-lg border border-line px-2.5 text-detail text-ink-muted opacity-0 transition-[color,border-color,opacity] duration-[var(--ly-t-quick)] group-hover/card:opacity-100 hover:border-ink-faint hover:text-ink focus-visible:opacity-100 disabled:opacity-50"
					>
						{busy === "install" ? (
							<Loader2 size={11.5} strokeWidth={2} className="ly-spin" />
						) : (
							<Download size={11.5} strokeWidth={1.9} />
						)}
						安装
					</button>
				)}

				<button
					type="button"
					aria-label={`${item.name} 的更多操作`}
					aria-haspopup="menu"
					aria-expanded={menu.open}
					onClick={menu.toggle}
					className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-faint opacity-0 transition-[color,background-color,opacity] duration-[var(--ly-t-quick)] group-hover/card:opacity-100 hover:bg-card-hover hover:text-ink focus-visible:opacity-100 aria-expanded:opacity-100"
				>
					<MoreHorizontal size={15} strokeWidth={1.9} />
				</button>
			</div>

			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width={190}>
					<div className="p-1">
						{!installed && item.entry && (
							<MenuItem
								icon={<Download size={14} strokeWidth={1.8} />}
								onClick={() => {
									menu.close();
									void install();
								}}
							>
								安装
							</MenuItem>
						)}
						{item.installed && (
							<MenuItem
								icon={<FolderOpen size={14} strokeWidth={1.8} />}
								onClick={() => {
									menu.close();
									void window.lyra.system.openPath(item.installed!.dir);
								}}
							>
								打开目录
							</MenuItem>
						)}
						{item.entry?.homepage && (
							<MenuItem
								icon={<ExternalLink size={14} strokeWidth={1.8} />}
								onClick={() => {
									menu.close();
									void window.lyra.system.openExternal(item.entry!.homepage!);
								}}
							>
								打开主页
							</MenuItem>
						)}
						{installed && (
							<MenuItem
								danger
								icon={<Trash2 size={14} strokeWidth={1.8} />}
								disabled={busy !== null || item.installed?.source === "workspace"}
								title={
									item.installed?.source === "workspace" ? "项目里的插件，从项目目录里删" : undefined
								}
								onClick={() => {
									menu.close();
									void uninstall();
								}}
							>
								卸载
							</MenuItem>
						)}
					</div>
				</Popover>
			)}
		</div>
	);
}
