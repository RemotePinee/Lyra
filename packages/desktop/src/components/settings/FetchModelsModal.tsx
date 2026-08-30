/**
 * Modal to select and import discovered models from a provider's /v1/models endpoint.
 */

import { Check, CheckSquare, Search, Square, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ModelIcon } from "../ModelIcon.tsx";

export function FetchModelsModal({
	open,
	models,
	existingModelIds,
	onClose,
	onImport,
}: {
	open: boolean;
	models: string[];
	existingModelIds: Set<string>;
	onClose: () => void;
	onImport: (selectedIds: string[]) => void;
}) {
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<Set<string>>(() => {
		// Default: select all non-existing models
		return new Set(models.filter((m) => !existingModelIds.has(m)));
	});

	// Filter by search term
	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return models;
		return models.filter((m) => m.toLowerCase().includes(q));
	}, [models, search]);

	if (!open) return null;

	const allSelected = filtered.length > 0 && filtered.every((m) => selected.has(m));
	const someSelected = filtered.some((m) => selected.has(m));

	function toggleAll() {
		if (allSelected) {
			const next = new Set(selected);
			for (const m of filtered) next.delete(m);
			setSelected(next);
		} else {
			const next = new Set(selected);
			for (const m of filtered) next.add(m);
			setSelected(next);
		}
	}

	function toggle(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setSelected(next);
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4 ly-fade-in">
			<div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line-soft bg-card shadow-2xl ly-scale-in">
				{/* Header */}
				<div className="flex items-center justify-between border-b border-line px-5 py-3.5">
					<div className="flex items-center gap-2">
						<span className="text-body font-medium text-ink">拉取并选择模型</span>
						<span className="rounded-full bg-card-hover px-2 py-0.5 text-caption text-ink-muted">
							共 {models.length} 个
						</span>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg p-1 text-ink-faint transition-colors hover:bg-card-hover hover:text-ink cursor-pointer"
					>
						<X size={16} />
					</button>
				</div>

				{/* Search & Actions Bar */}
				<div className="flex items-center gap-2.5 border-b border-line px-5 py-2.5 bg-card-hover/20">
					<div className="relative flex-1">
						<Search size={14} className="absolute left-2.5 top-2.5 text-ink-faint" />
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="搜索模型名称或厂商…"
							className="w-full rounded-lg border border-line bg-card pl-8 pr-3 py-1.5 text-caption text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
						/>
					</div>
					<button
						type="button"
						onClick={toggleAll}
						className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-caption text-ink-muted transition-colors hover:bg-card hover:text-ink cursor-pointer"
					>
						{allSelected ? (
							<CheckSquare size={14} className="text-accent" />
						) : someSelected ? (
							<div className="h-3.5 w-3.5 rounded border border-accent bg-accent/20 flex items-center justify-center">
								<div className="h-1.5 w-1.5 bg-accent rounded-sm" />
							</div>
						) : (
							<Square size={14} className="text-ink-faint" />
						)}
						<span>{allSelected ? "取消全选" : "全选"}</span>
					</button>
				</div>

				{/* List Scroller */}
				<div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5 max-h-[460px]">
					{filtered.length === 0 ? (
						<div className="py-12 text-center text-caption text-ink-faint">没有找到匹配的模型</div>
					) : (
						filtered.map((modelId) => {
							const checked = selected.has(modelId);
							const isExisting = existingModelIds.has(modelId);
							return (
								<label
									key={modelId}
									className={`flex items-center justify-between rounded-xl border p-2.5 transition-all cursor-pointer select-none ${
										checked
											? "border-accent/40 bg-accent/[0.04]"
											: "border-line bg-card hover:border-line-soft hover:bg-card-hover/40"
									}`}
								>
									<div className="flex items-center gap-3 min-w-0 pr-2">
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												toggle(modelId);
											}}
											className="shrink-0 text-ink-muted focus:outline-none"
										>
											{checked ? (
												<CheckSquare size={16} className="text-accent" />
											) : (
												<Square size={16} className="text-ink-faint hover:text-ink" />
											)}
										</button>
										<ModelIcon model={modelId} size={16} />
										<div className="min-w-0">
											<div className="flex items-center gap-1.5">
												<span className="font-mono text-label text-ink truncate">{modelId}</span>
												{isExisting && (
													<span className="shrink-0 rounded bg-ink-faint/10 px-1 py-0.2 text-micro text-ink-faint">
														已添加
													</span>
												)}
											</div>
										</div>
									</div>
									<span className="shrink-0 text-caption text-ink-faint font-mono">200K</span>
								</label>
							);
						})
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-between border-t border-line px-5 py-3 bg-card-hover/10">
					<span className="text-caption text-ink-muted">
						已选择 <strong className="text-ink font-medium">{selected.size}</strong> 个模型
					</span>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={onClose}
							className="rounded-lg px-3 py-1.5 text-caption text-ink-muted transition-colors hover:bg-card-hover hover:text-ink cursor-pointer"
						>
							取消
						</button>
						<button
							type="button"
							disabled={selected.size === 0}
							onClick={() => onImport(Array.from(selected))}
							className="flex items-center gap-1.5 rounded-lg bg-ink px-4 py-1.5 text-caption font-medium text-shell transition-opacity hover:opacity-90 disabled:opacity-40 cursor-pointer"
						>
							<Check size={13} strokeWidth={2.2} />
							导入所选 ({selected.size})
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
