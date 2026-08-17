/**
 * What is installed, and whether it is on.
 *
 * That is the whole page. Every plugin used to arrive here as a card with three badges, two
 * counts, a 详情 disclosure and a 打开目录 link — nine pieces of information for a question with
 * two possible answers, repeated down the page until nothing on it could be found at a glance.
 *
 * Everything that was taken off is still reachable, one click further away and somewhere it makes
 * more sense: the version, the licence, the skills it carries and the servers it declares are the
 * bundle's own page, which exists and says all of it at length. 管理 goes there. The directory is
 * behind the ⋯, where you look for it when you already know you want it.
 */

import type { Plugin } from "@lyra/core";
import { FolderOpen, MoreHorizontal, Settings2, TriangleAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { ConfirmBody } from "../Confirm.tsx";
import { MenuBody, MenuItem, MenuSeparator, Popover, usePopover } from "../Popover.tsx";
import { useApp } from "../../store.ts";
import { Card, ListRow, SectionTitle, Toggle } from "./controls.tsx";
import { PluginIcon } from "./PluginIcon.tsx";

export function PluginsSettings({ filter = "" }: { filter?: string }) {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);
	const workspace = useApp((s) => s.workspace);
	const setView = useApp((s) => s.setView);
	const setPluginFocus = useApp((s) => s.setPluginFocus);
	const extensionsNonce = useApp((s) => s.extensionsNonce);
	const bumpExtensions = useApp((s) => s.bumpExtensions);
	const [scan, setScan] = useState<Awaited<ReturnType<typeof window.lyra.plugins.list>> | null>(null);

	const refresh = async () => setScan(await window.lyra.plugins.list(workspace?.path ?? ""));

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspace?.path, settings?.disabledPlugins.length, extensionsNonce]);

	if (!settings) return null;
	const needle = filter.trim().toLowerCase();
	const plugins = (scan?.plugins ?? []).filter(
		(p) =>
			!needle ||
			`${p.id} ${p.manifest.name ?? ""} ${p.manifest.interface?.shortDescription ?? ""}`
				.toLowerCase()
				.includes(needle),
	);
	const diagnostics = scan?.pluginDiagnostics ?? [];

	/*
	 * `*` in `disabledPlugins` means "none of them", whoever wrote it there.
	 *
	 * Switching one back on has to clear that as well, or the toggle is a control that reports a
	 * change and produces none: the id is removed, the wildcard stays, and every plugin is still
	 * off after a reload. Turning the wildcard off means naming what it stood for — everything
	 * currently on disk except the one being switched on.
	 */
	const allOff = settings.disabledPlugins.includes("*");

	const toggle = (plugin: Plugin, enabled: boolean) => {
		const disabled = new Set(settings.disabledPlugins);
		if (allOff && enabled) {
			disabled.delete("*");
			for (const other of scan?.plugins ?? []) if (other.id !== plugin.id) disabled.add(other.id);
		}
		if (enabled) disabled.delete(plugin.id);
		else disabled.add(plugin.id);
		void saveSettings({ ...settings, disabledPlugins: [...disabled] });
	};

	/** The bundle's own page, in the catalogue — which is a different view, not a panel in here. */
	const manage = (plugin: Plugin) => {
		setPluginFocus(plugin.id);
		setView("plugins");
	};

	return (
		<div>
			{diagnostics.length > 0 && (
				<Card className="mb-6 border-accent/35 bg-accent/6">
					<div className="px-4 py-3">
						<div className="mb-2 flex items-center gap-1.5 text-label text-accent">
							<TriangleAlert size={13} strokeWidth={1.9} />
							{diagnostics.length} 个插件问题
						</div>
						{diagnostics.map((diagnostic) => (
							<div key={diagnostic.path} className="py-0.5 text-detail text-accent/85">
								<span className="font-mono">{diagnostic.path}</span> — {diagnostic.message}
							</div>
						))}
					</div>
				</Card>
			)}

			{/*
			 * Said out loud, because otherwise the page is a list of plugins that are all off for no
			 * visible reason — indistinguishable from having switched each one off.
			 */}
			{allOff && plugins.length > 0 && (
				<p className="mb-3 rounded-[10px] border border-line-soft px-3 py-2 text-detail leading-relaxed text-ink-muted">
					设置里写着 <code className="font-mono">disabledPlugins: ["*"]</code>，所以下面所有插件都不生效。
					把任意一个拨回「开」会解除这条总开关，其余插件保持当前状态。
				</p>
			)}

			<SectionTitle>已安装（{plugins.length}）</SectionTitle>

			<Card>
				{plugins.length === 0 ? (
					<div className="px-4 py-8 text-center">
						<p className="text-label leading-relaxed text-ink-muted">
							{needle ? "没有匹配的插件。" : "还没有插件。去插件市场装一个，或把插件目录放进 ~/.lyra/plugins。"}
						</p>

					</div>
				) : (
					plugins.map((plugin) => (
						<PluginRow
							key={plugin.id}
							plugin={plugin}
							onToggle={(enabled) => toggle(plugin, enabled)}
							onManage={() => manage(plugin)}
							onRemoved={() => {
								void refresh();
								bumpExtensions();
							}}
						/>
					))
				)}
			</Card>
		</div>
	);
}

function PluginRow({
	plugin,
	onToggle,
	onManage,
	onRemoved,
}: {
	plugin: Plugin;
	onToggle: (enabled: boolean) => void;
	onManage: () => void;
	onRemoved: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const menu = usePopover();
	const [confirming, setConfirming] = useState(false);
	const ui = plugin.manifest.interface;
	const name = ui?.displayName ?? plugin.manifest.name ?? plugin.id;
	/** A bundle inside the project's own directory is removed by deleting it there. */
	const removable = plugin.source !== "workspace";

	const close = () => {
		menu.close();
		setConfirming(false);
	};

	const uninstall = async () => {
		setBusy(true);
		await window.lyra.plugins.uninstall(plugin.id);
		setBusy(false);
		onRemoved();
	};

	return (
		<>
			<ListRow
				icon={<PluginIcon name={name} logo={ui?.logo} brandColor={ui?.brandColor} size={28} />}
				title={name}
				detail={ui?.shortDescription ?? plugin.manifest.description ?? "（无描述）"}
				onOpen={onManage}
				openLabel={`打开 ${name}`}
				actions={
					<button
						type="button"
						aria-label={`${name} 的更多操作`}
						aria-haspopup="menu"
						aria-expanded={menu.open}
						onClick={menu.toggle}
						className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-faint opacity-0 transition-[color,background-color,opacity] duration-[var(--ly-t-quick)] group-hover/row:opacity-100 hover:bg-card-hover hover:text-ink focus-visible:opacity-100 aria-expanded:opacity-100"
					>
						<MoreHorizontal size={15} strokeWidth={1.9} />
					</button>
				}
				control={<Toggle checked={plugin.enabled} onChange={onToggle} />}
			/>

			{menu.open && (
				<Popover
					anchor={menu.anchor}
					onClose={close}
					placement="bottom"
					align="end"
					width={confirming ? "panel" : "compact"}
					role={confirming ? "dialog" : "menu"}
					label={name}
				>
					{confirming ? (
						<ConfirmBody
							title={`卸载 ${name}？`}
							detail="它的目录会被删除，随它安装的技能也一起消失。重新安装可以拿回来。"
							confirmLabel="卸载"
							onCancel={close}
							onConfirm={() => {
								close();
								void uninstall();
							}}
						/>
					) : (
						<MenuBody>
							<MenuItem
								icon={<Settings2 size={13} strokeWidth={1.8} />}
								onClick={() => {
									close();
									onManage();
								}}
							>
								管理
							</MenuItem>
							<MenuItem
								icon={<FolderOpen size={13} strokeWidth={1.8} />}
								onClick={() => {
									close();
									void window.lyra.system.openPath(plugin.dir);
								}}
							>
								打开目录
							</MenuItem>

							<MenuSeparator />

							<MenuItem
								danger
								icon={<Trash2 size={13} strokeWidth={1.8} />}
								disabled={busy || !removable}
								title={removable ? undefined : "项目里的插件，从项目目录里删"}
								onClick={() => setConfirming(true)}
							>
								卸载
							</MenuItem>
						</MenuBody>
					)}
				</Popover>
			)}
		</>
	);
}
