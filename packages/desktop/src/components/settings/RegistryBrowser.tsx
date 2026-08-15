import { Check, Download, Loader2, Plus, Store, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import type { Registry, RegistryEntry } from "../../../electron/ipc-types.ts";
import { Overlay } from "../modals/Overlay.tsx";
import { Scroller } from "../Scroller.tsx";
import { SearchField } from "../SearchField.tsx";
import { useApp } from "../../store.ts";
import { GhostButton, TextInput } from "./controls.tsx";
import { PluginIcon } from "./PluginIcon.tsx";

/**
 * Browse and install from plugin registries.
 *
 * A registry is one JSON file at a URL listing bundles and where to clone them from — there is
 * no service to run and no format to adopt, which is why the collections that already exist
 * can be added as-is. Several can be configured at once and are shown merged, because from
 * here the question is "what can I install", not "who published it".
 */
export function RegistryBrowser({ onClose }: { onClose: () => void }) {
	const settings = useApp((s) => s.settings);
	const saveSettings = useApp((s) => s.saveSettings);

	const [registries, setRegistries] = useState<Registry[]>([]);
	const [errors, setErrors] = useState<{ url: string; message: string }[]>([]);
	const [loading, setLoading] = useState(true);
	const [query, setQuery] = useState("");
	const [adding, setAdding] = useState("");
	const [installing, setInstalling] = useState<string | null>(null);
	const [installed, setInstalled] = useState<Set<string>>(new Set());

	const urls = settings?.pluginRegistries ?? [];

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void Promise.all(urls.map((url) => window.deepwise.plugins.fetchRegistry(url))).then((results) => {
			if (cancelled) return;
			setRegistries(results.flatMap((r, i) => (r.ok ? [r.registry] : [])));
			setErrors(results.flatMap((r, i) => (r.ok ? [] : [{ url: urls[i], message: r.message }])));
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [urls.join("|")]);

	const addRegistry = () => {
		const url = adding.trim();
		if (!settings || !url) return;
		if (urls.includes(url)) return setAdding("");
		void saveSettings({ ...settings, pluginRegistries: [...urls, url] });
		setAdding("");
	};

	const removeRegistry = (url: string) => {
		if (!settings) return;
		void saveSettings({ ...settings, pluginRegistries: urls.filter((u) => u !== url) });
	};

	const install = async (entry: RegistryEntry) => {
		setInstalling(entry.id);
		const result = await window.deepwise.plugins.installFromRegistry(entry);
		setInstalling(null);
		if (result.ok) setInstalled((current) => new Set(current).add(entry.id));
		else setErrors((current) => [...current, { url: entry.name, message: result.message }]);
	};

	const needle = query.trim().toLowerCase();
	const entries = registries
		.flatMap((registry) => registry.entries.map((entry) => ({ entry, from: registry.name })))
		.filter(({ entry }) => !needle || `${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(needle));

	return (
		<Overlay onClose={onClose} width={620}>
			<div className="flex max-h-[80vh] flex-col">
				<div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3.5">
					<Store size={16} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
					<span className="text-[14px] font-medium text-ink">插件市场</span>
					<div className="min-w-2 flex-1" />
					<SearchField value={query} onChange={setQuery} placeholder="搜索" className="w-[180px]" />
				</div>

				<Scroller className="min-h-0 flex-1" contentClassName="px-5 py-4" fadeColor="var(--color-elevated)">
					{/* The sources themselves, so a bad one can be removed rather than just failing. */}
					<div className="mb-4 flex flex-col gap-1.5">
						{urls.map((url) => {
							const failed = errors.find((e) => e.url === url);
							return (
								<div key={url} className="flex items-center gap-2 text-[11.5px]">
									<span className={`min-w-0 flex-1 truncate font-mono ${failed ? "text-danger" : "text-ink-faint"}`}>
										{url}
									</span>
									{failed && <span className="shrink-0 text-danger">{failed.message}</span>}
									<button
										type="button"
										data-dw-tip="移除这个市场"
										onClick={() => removeRegistry(url)}
										className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger"
									>
										<Trash2 size={12} strokeWidth={1.8} />
									</button>
								</div>
							);
						})}

						<div className="flex items-center gap-2 pt-1">
							<TextInput
								value={adding}
								onChange={setAdding}
								onKeyDown={(event) => event.key === "Enter" && addRegistry()}
								placeholder="https://…/registry.json"
								mono
								className="h-[30px] flex-1 text-[12px]"
							/>
							<GhostButton onClick={addRegistry} icon={<Plus size={12} strokeWidth={2} />}>
								添加市场
							</GhostButton>
						</div>
					</div>

					{loading ? (
						<p className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-ink-faint">
							<Loader2 size={13} strokeWidth={2} className="dw-spin" />
							读取中…
						</p>
					) : entries.length === 0 ? (
						<p className="py-10 text-center text-[12.5px] text-ink-faint">
							{urls.length === 0 ? "还没有添加任何市场" : "没有匹配的插件"}
						</p>
					) : (
						<div className="flex flex-col gap-0.5">
							{entries.map(({ entry, from }) => (
								<div key={`${from}:${entry.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2">
									<PluginIcon name={entry.name} logo={entry.logo} brandColor={entry.brandColor} />
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-[13px] text-ink">{entry.name}</span>
											<span className="shrink-0 text-[11px] text-ink-faint">{from}</span>
										</div>
										{entry.description && (
											<p className="truncate text-[12px] text-ink-muted">{entry.description}</p>
										)}
									</div>

									{installed.has(entry.id) ? (
										<span className="flex shrink-0 items-center gap-1 text-[11.5px] text-ok">
											<Check size={12} strokeWidth={2.2} />
											已安装
										</span>
									) : (
										<GhostButton
											disabled={installing !== null}
											onClick={() => void install(entry)}
											icon={
												installing === entry.id ? (
													<Loader2 size={12} strokeWidth={2} className="dw-spin" />
												) : (
													<Download size={12} strokeWidth={1.9} />
												)
											}
										>
											安装
										</GhostButton>
									)}
								</div>
							))}
						</div>
					)}

					{installed.size > 0 && (
						<p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
							<TriangleAlert size={12} strokeWidth={1.9} />
							新建会话后生效；带来的 MCP 服务默认关闭，需要自己启用。
						</p>
					)}
				</Scroller>
			</div>
		</Overlay>
	);
}
