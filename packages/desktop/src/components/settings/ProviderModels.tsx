/**
 * The models one provider offers, and whether the connection works.
 *
 * Separate from the provider's own fields because they answer different questions. The fields
 * above are "how do I reach this thing"; this is "what can it do, and did it answer" — which is
 * also the order you fill them in, and the only part you come back to later.
 *
 * The test outcome lives here rather than beside the URL for the same reason: what a successful
 * test tells you is which models the endpoint reports, so it belongs next to the list you are
 * about to compare it against.
 */

import { Link2, Pencil, Plus, Trash2 } from "lucide-react";
import type { ModelConfig } from "@lyra/core";
import type { ProviderTestResult } from "../../../electron/ipc-types.ts";
import { useConfirmer } from "../Confirm.tsx";
import { ModelIcon } from "../ModelIcon.tsx";
import { formatWindow } from "../ModelMenu.tsx";
import { RollingText } from "../RollingText.tsx";
import { Scroller } from "../Scroller.tsx";
import { ScrollText } from "../ScrollText.tsx";
import { Badge, GhostButton } from "./controls.tsx";

export function ProviderModels({
	models,
	defaultModelId,
	testResult,
	testing,
	onTest,
	onEdit,
	onRemove,
	onSetDefault,
}: {
	models: ModelConfig[];
	defaultModelId: string | null;
	testResult: ProviderTestResult | null;
	testing: boolean;
	onTest: () => void;
	/** `null` adds a new one. */
	onEdit: (model: ModelConfig | null) => void;
	onRemove: (modelId: string) => void;
	onSetDefault: (modelId: string) => void;
}) {
	return (
		<div className="pt-6">
			<div className="mb-2 flex items-center justify-between">
				<span className="text-label text-ink-muted">模型列表</span>
				<GhostButton onClick={onTest} disabled={testing}>
					<RollingText>{testing ? "测试中…" : "测试连接"}</RollingText>
				</GhostButton>
			</div>

			<div className="space-y-2">
				{models.map((model) => (
					<ModelRow
						key={model.id}
						model={model}
						isDefault={defaultModelId === model.id}
						onEdit={() => onEdit(model)}
						onRemove={() => onRemove(model.id)}
						onSetDefault={() => onSetDefault(model.id)}
					/>
				))}

				<button
					type="button"
					onClick={() => onEdit(null)}
					className="flex h-[38px] items-center gap-2 rounded-[10px] border border-line px-3 text-label text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
				>
					<Plus size={14} strokeWidth={1.9} />
					添加模型
				</button>
			</div>

			{testResult && <TestOutcome result={testResult} />}
		</div>
	);
}

function ModelRow({
	model,
	isDefault,
	onEdit,
	onRemove,
	onSetDefault,
}: {
	model: ModelConfig;
	isDefault: boolean;
	onEdit: () => void;
	onRemove: () => void;
	onSetDefault: () => void;
}) {
	const confirm = useConfirmer();

	return (
		<div className="flex h-[46px] items-center gap-3 rounded-[10px] border border-line bg-input px-3.5">
			{/* Tighter than the row's own spacing: the mark belongs to the id beside it, and at the
			    row's 12px it read as a separate column. */}
			<span className="flex min-w-0 flex-1 items-center gap-2">
				<ModelIcon model={model.modelId} name={model.name} size={15} />
				<ScrollText text={model.modelId} className="min-w-0 flex-1 font-mono text-label text-ink" />
			</span>
			{isDefault && <Badge tone="accent">默认</Badge>}
			<span className="rounded bg-card px-1.5 py-0.5 font-mono text-caption text-ink-faint">
				{formatWindow(model.contextWindow)}
			</span>
			<button
				type="button"
				data-ly-tip="设为默认模型"
				aria-label="设为默认模型"
				onClick={onSetDefault}
				className="text-ink-faint transition-colors hover:text-ink"
			>
				<Link2 size={14} strokeWidth={1.8} />
			</button>
			<button
				type="button"
				data-ly-tip="编辑"
				aria-label="编辑模型"
				onClick={onEdit}
				className="text-ink-faint transition-colors hover:text-ink"
			>
				<Pencil size={14} strokeWidth={1.8} />
			</button>
			<button
				type="button"
				data-ly-tip="删除"
				aria-label="删除模型"
				onClick={(event) =>
					confirm.ask(event, {
						title: `删除 ${model.modelId}？`,
						detail: isDefault ? "它是当前的默认模型，删掉之后要另选一个。" : undefined,
						confirmLabel: "删除",
						onConfirm: onRemove,
					})
				}
				className="text-ink-faint transition-colors hover:text-danger"
			>
				<Trash2 size={14} strokeWidth={1.8} />
			</button>

			{confirm.element}
		</div>
	);
}

/** What the endpoint said, kept as it was said — including the model list it reports. */
function TestOutcome({ result }: { result: ProviderTestResult }) {
	return (
		<div
			className={`mt-3 rounded-[10px] border px-3.5 py-2.5 text-label ${
				result.ok ? "border-ok/35 bg-ok/8 text-ok" : "border-danger/35 bg-danger/8 text-danger"
			}`}
		>
			{result.message}
			{result.latencyMs > 0 && <span className="opacity-70"> · {result.latencyMs} ms</span>}
			{result.models && result.models.length > 0 && (
				<details className="mt-1.5">
					<summary className="cursor-pointer opacity-80">端点上报的模型（{result.models.length}）</summary>
					<Scroller className="mt-1 max-h-[160px]" contentClassName="font-mono text-detail opacity-80">
						{result.models.join("\n")}
					</Scroller>
				</details>
			)}
		</div>
	);
}
