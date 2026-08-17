/**
 * One bundle in the catalogue.
 *
 * A card, not a settings row: a mark, a name, one line about what it does, and nothing else on
 * the surface. Everything that could be done to it lives behind the ⋯, which is what keeps a grid
 * of twenty of these readable — a row with a toggle, a version, a source badge and two links on
 * it is a form, and a page of forms cannot be skimmed. What you already have is said once, in the
 * corner, because that is the only fact you are scanning for.
 *
 * The two states have one control each, and it is never the same one:
 *
 *   - not installed — 安装, and only that. It is why the page exists, and it is stated rather
 *     than revealed on hover, because a button you have to find is a button most people do not.
 *   - installed — ⋯, and only that. There is nothing left to press: what remains is trying it,
 *     going to its page, and getting rid of it, none of which is the one obvious next thing.
 *
 * Both used to be on at once, which put an 安装 button beside a ⋯ menu whose first item was also
 * 安装, and then took both away the moment the thing was installed — so the card was busiest when
 * there was one choice and emptiest when there were three.
 *
 * The card body is a button and the action is its sibling laid over its right-hand end. A button
 * inside a button is not a thing the platform has, and wrapping the whole card in one would mean
 * stopping propagation on every control inside it — which works right up until the one that gets
 * added later and does not.
 */

import { Check, Download, FolderOpen, Loader2, MoreHorizontal, Play, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfirmBody } from "../Confirm.tsx";
import { MenuBody, MenuItem, MenuSeparator, Popover, usePopover } from "../Popover.tsx";
import { PluginIcon } from "../settings/PluginIcon.tsx";
import { isEnabled, isInstalled, type CatalogItem } from "./useCatalog.ts";

export function CatalogCard({
	item,
	onOpen,
	onChanged,
	onError,
	onTry,
}: {
	item: CatalogItem;
	onOpen: () => void;
	/** Something on disk moved; the catalogue has to be re-read. */
	onChanged: () => void;
	onError: (message: string) => void;
	/** Starts a conversation with one of the bundle's own example prompts already typed. */
	onTry: (prompt: string) => void;
}) {
	const menu = usePopover();
	const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
	/**
	 * The menu turns into the question rather than opening a second surface over itself.
	 *
	 * Stacking a confirmation on top of the menu that raised it means two panels, two shadows and
	 * a menu still sitting there behind the thing that replaced it. Reset whenever the menu closes,
	 * so it never reopens on the question nobody answered.
	 */
	const [confirming, setConfirming] = useState(false);

	const plugin = item.installed;
	const bundle = item.bundle;
	const installed = isInstalled(item);
	/** Where the directory is, whichever kind it turned out to be. */
	/*
	 * Where "打开目录" goes, and the thing whose absence used to hide the whole menu.
	 *
	 * A skill collection has no directory of its own — its skills sit among the loose ones. That
	 * left `dir` null, and the menu is gated on it, so an installed collection had no way to be
	 * uninstalled at all: no 安装 button any more, and no ⋯ menu either. The folder its skills went
	 * into is the honest answer to "show me this", even though it holds more than this.
	 */
	const dir = plugin?.dir ?? bundle?.dir ?? item.collectedIn;
	/*
	 * Trying it means running one of its own example prompts, so it takes both a prompt to run and
	 * something that is actually live — offering it while the bundle is switched off would open a
	 * conversation that silently lacks the thing being demonstrated. For an MCP bundle "live"
	 * means at least one of its servers is enabled, which is a per-server switch on the MCP page.
	 */
	const manifest = plugin?.manifest ?? bundle?.manifest;
	const trial = isEnabled(item) ? (manifest?.interface?.defaultPrompt?.[0] ?? null) : null;
	/** A bundle that lives in the project's own directory is removed by deleting it there. */
	const removable = installed && (plugin?.source ?? bundle?.source) !== "workspace";

	const close = () => {
		menu.close();
		setConfirming(false);
	};

	const install = async () => {
		if (!item.entry) return;
		setBusy("install");
		const result = await window.lyra.plugins.installFromRegistry(item.entry, item.from ?? undefined);
		setBusy(null);
		if (!result.ok) {
			onError(`${item.name}：${result.message}`);
			return;
		}
		/*
		 * Said out loud when the index was wrong about what this is.
		 *
		 * The kind on the card came from the registry, and the registry is guessing; the clone is
		 * what settles it. Landing an MCP server in the plugins tab without a word would leave
		 * someone looking for it under the wrong heading, and its servers arrive switched off, so
		 * there is a second thing to do that nothing else would mention.
		 */
		// `kind` is absent when the main process predates the split — say nothing rather than
		// claim it turned out to be something else.
		if (result.kind && result.kind !== item.kind) {
			onError(
				result.kind === "mcp"
					? `${item.name} 其实是一个 MCP 服务，已装到「MCP 服务」下；它的 ${result.servers} 个服务默认关着，去设置 › MCP 里开。`
					: `${item.name} 其实是一个插件，已装到「插件」下。`,
			);
		} else if (result.kind === "mcp") {
			onError(`${item.name} 已安装，${result.servers} 个服务默认关着——去设置 › MCP 里开。`);
		}
		onChanged();
	};

	const uninstall = async () => {
		setBusy("uninstall");
		await window.lyra.plugins.uninstall(item.id);
		setBusy(null);
		onChanged();
	};

	return (
		<div className="group/card relative">
			<button
				type="button"
				onClick={onOpen}
				className="flex w-full items-start gap-3 rounded-xl p-3 pr-20 text-left transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover/60"
			>
				<PluginIcon
					name={item.name}
					id={item.id}
					logo={item.logo}
					brandColor={item.brandColor}
					category={item.category}
					size={36}
				/>

				<div className="min-w-0 flex-1 pt-0.5">
					<div className="flex items-center gap-2">
						<span className="truncate text-label font-medium text-ink">{item.name}</span>
						{installed && (
							<span
								className={`flex shrink-0 items-center gap-1 text-caption ${
									isEnabled(item) || item.collected > 0 ? "text-ok" : "text-ink-faint"
								}`}
							>
								<Check size={11} strokeWidth={2.4} />
								{/*
								 * An MCP bundle starts with every server off, and "已停用" would read as
								 * something the user did rather than as where it begins.
								 *
								 * A skill collection has no switch at all — its skills are simply among the
								 * loose ones once it is installed. It reported 已停用, naming a state that
								 * does not exist and cannot be changed. The count is the useful fact and the
								 * one thing worth checking: it is what the card promised before installing.
								 */}
								{item.collected > 0
									? `${item.collected} 个技能`
									: isEnabled(item)
										? "已安装"
										: item.kind === "mcp"
											? "未启用"
											: "已停用"}
							</span>
						)}
					</div>
					<p className="mt-0.5 line-clamp-2 text-detail leading-relaxed text-ink-muted">
						{item.description || "（没有描述）"}
					</p>
				</div>
			</button>

			{/*
			 * The strip takes no pointer events; only the button on it does. Anything wider would
			 * shadow the card button underneath and cost it both its click and its hover.
			 */}
			{/*
			 * Centred against the card, not pinned to its top.
			 *
			 * `top-3` put it level with the first line of the title, which is right only when the card
			 * is exactly one line tall. A two-line description makes the card taller and leaves the
			 * button sitting up in a corner, which reads as though it belongs to the title rather than
			 * to the entry.
			 */}
			<div className="pointer-events-none absolute inset-y-0 right-3 flex items-center gap-0.5">
				{installed ? (
					<button
						type="button"
						aria-label={`${item.name} 的更多操作`}
						aria-haspopup="menu"
						aria-expanded={menu.open}
						onClick={menu.toggle}
						className="pointer-events-auto flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-faint opacity-0 transition-[color,background-color,opacity] duration-[var(--ly-t-quick)] group-hover/card:opacity-100 hover:bg-card-hover hover:text-ink focus-visible:opacity-100 aria-expanded:opacity-100"
					>
						{busy === "uninstall" ? (
							<Loader2 size={13} strokeWidth={2} className="ly-spin" />
						) : (
							<MoreHorizontal size={15} strokeWidth={1.9} />
						)}
					</button>
				) : (
					item.entry && (
						<button
							type="button"
							disabled={busy !== null}
							onClick={() => void install()}
							className="pointer-events-auto flex h-[26px] items-center gap-1.5 rounded-lg border border-line bg-shell/80 px-2.5 text-detail text-ink-muted transition-[color,border-color,opacity] duration-[var(--ly-t-quick)] hover:border-ink-faint hover:text-ink disabled:opacity-50"
						>
							{busy === "install" ? (
								<Loader2 size={11.5} strokeWidth={2} className="ly-spin" />
							) : (
								<Download size={11.5} strokeWidth={1.9} />
							)}
							安装
						</button>
					)
				)}
			</div>

			{/* Being installed is what opens this menu, and being installed is what gives it a
			    directory — named again so the rows below can use it without re-asking. */}
			{menu.open && dir && (
				<Popover
					anchor={menu.anchor}
					onClose={close}
					placement="bottom"
					align="end"
					width={confirming ? "panel" : "compact"}
					role={confirming ? "dialog" : "menu"}
					label={item.name}
				>
					{confirming ? (
						<ConfirmBody
							title={`卸载 ${item.name}？`}
							detail={
								item.kind === "mcp"
									? `它的目录会被删除，它在设置 › MCP 里的 ${item.servers.length} 条配置也一起清掉——包括你在那里改过的参数。`
									: item.collected > 0
										? `它带来的 ${item.collected} 个技能会从技能目录里删掉，你自己放的技能不受影响。重新安装可以拿回来。`
										: "它的目录会被删除，随它安装的技能也一起消失。重新安装可以拿回来。"
							}
							confirmLabel="卸载"
							onCancel={close}
							onConfirm={() => {
								close();
								void uninstall();
							}}
						/>
					) : (
						<MenuBody>
							{trial && (
								<MenuItem
									icon={<Play size={13} strokeWidth={1.8} />}
									onClick={() => {
										close();
										onTry(trial);
									}}
								>
									立即试用
								</MenuItem>
							)}
							<MenuItem
								icon={<Settings2 size={13} strokeWidth={1.8} />}
								onClick={() => {
									close();
									onOpen();
								}}
							>
								管理
							</MenuItem>
							<MenuItem
								icon={<FolderOpen size={13} strokeWidth={1.8} />}
								onClick={() => {
									close();
									void window.lyra.system.openPath(dir);
								}}
							>
								打开目录
							</MenuItem>

							<MenuSeparator />

							<MenuItem
								danger
								icon={<Trash2 size={13} strokeWidth={1.8} />}
								disabled={busy !== null || !removable}
								title={removable ? undefined : "项目里的插件，从项目目录里删"}
								onClick={() => setConfirming(true)}
							>
								卸载
							</MenuItem>
						</MenuBody>
					)}
				</Popover>
			)}
		</div>
	);
}
