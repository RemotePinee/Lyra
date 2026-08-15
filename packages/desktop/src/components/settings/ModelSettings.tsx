import type { ApiFormat, ModelConfig, ProviderConfig } from "@deepwise/core";
import { ScrollText } from "../ScrollText.tsx";
import { Scroller } from "../Scroller.tsx";
import { Box, Link2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderTestResult } from "../../../electron/ipc-types.ts";
import { useApp } from "../../store.ts";
import { formatWindow } from "../ModelMenu.tsx";
import { ModelEditor } from "./ModelEditor.tsx";
import {
  Badge,
  Field,
  GhostButton,
  SecretInput,
  Select,
  TextInput,
} from "./controls.tsx";

const API_OPTIONS: { value: ApiFormat; label: string }[] = [
  { value: "openai-responses", label: "Responses (/responses)" },
  { value: "anthropic-messages", label: "Messages (/messages)" },
];

export function ModelSettings() {
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const providers = settings?.providers ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(
    providers[0]?.id ?? null,
  );
  const [editingModel, setEditingModel] = useState<{
    providerId: string;
    model: ModelConfig | null;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  const selected = useMemo(
    () => providers.find((p) => p.id === selectedId) ?? providers[0] ?? null,
    [providers, selectedId],
  );

  useEffect(() => {
    if (!selected && providers.length > 0) setSelectedId(providers[0].id);
  }, [providers, selected]);

  async function updateProvider(id: string, patch: Partial<ProviderConfig>) {
    if (!settings) return;
    await saveSettings({
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      ),
    });
  }

  async function addProvider() {
    if (!settings) return;
    const id = `provider-${Date.now().toString(36)}`;
    const provider: ProviderConfig = {
      id,
      name: "新供应商",
      baseUrl: "https://",
      api: "openai-responses",
      apiKey: "",
      enabled: true,
      models: [],
    };
    await saveSettings({
      ...settings,
      providers: [...settings.providers, provider],
    });
    setSelectedId(id);
    setTestResult(null);
  }

  async function removeProvider(id: string) {
    if (!settings) return;
    const remaining = settings.providers.filter((p) => p.id !== id);
    // A model from the removed provider must not stay selected as the default.
    const defaultStillValid = remaining.some((p) =>
      p.models.some((m) => m.id === settings.defaultModelId),
    );
    await saveSettings({
      ...settings,
      providers: remaining,
      defaultModelId: defaultStillValid
        ? settings.defaultModelId
        : (remaining[0]?.models[0]?.id ?? null),
    });
    setSelectedId(remaining[0]?.id ?? null);
  }

  async function saveModel(
    providerId: string,
    model: ModelConfig,
    original: ModelConfig | null,
  ) {
    if (!settings) return;
    await saveSettings({
      ...settings,
      providers: settings.providers.map((p) =>
        p.id !== providerId
          ? p
          : {
              ...p,
              models: original
                ? p.models.map((m) => (m.id === original.id ? model : m))
                : [...p.models, model],
            },
      ),
      defaultModelId: settings.defaultModelId ?? model.id,
    });
    setEditingModel(null);
  }

  async function removeModel(providerId: string, modelId: string) {
    if (!settings) return;
    await saveSettings({
      ...settings,
      providers: settings.providers.map((p) =>
        p.id !== providerId
          ? p
          : { ...p, models: p.models.filter((m) => m.id !== modelId) },
      ),
      defaultModelId:
        settings.defaultModelId === modelId ? null : settings.defaultModelId,
    });
  }

  async function runTest() {
    if (!selected) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await window.deepwise.providers.test(selected.id));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start justify-between pt-8 pb-6">
        <div>
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-ink">
            模型设置
          </h1>
          <p className="mt-2 text-[13px] text-ink-muted">
            管理自定义模型供应商，配置后可在聊天时选择使用。
          </p>
        </div>
        <button
          type="button"
          data-dw-tip="测试当前供应商连接"
          onClick={() => void runTest()}
          className="mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
        >
          <RefreshCw
            size={16}
            strokeWidth={1.8}
            className={testing ? "dw-pulse" : undefined}
          />
        </button>
      </header>

      {/*
       * Side by side when there is room, stacked when there is not.
       *
       * The list used to be a fixed 268px that never gave any of it back, so in a narrow
       * window the editor beside it was left with whatever remained — at 420px that was
       * 70px, and every field became a slot with one character in it. Measured against
       * this container rather than the window, because the settings pane is the full width
       * of a narrow window and a fraction of a wide one.
       */}
      {/* The query element and the queried element cannot be the same one: a container is
			    sized by its contents, so it is only ever asked about by its descendants. */}
      <div className="@container flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-line bg-card/30 @2xl:flex-row">
          {/* Each pane scrolls on its own, so a long provider list never moves the editor. */}
          <Scroller
            className="max-h-[168px] shrink-0 border-b border-line @2xl:max-h-none @2xl:w-[268px] @2xl:border-r @2xl:border-b-0"
            contentClassName="p-2.5"
            fadeColor="var(--color-shell)"
          >
            <div className="px-2 pt-1.5 pb-1 text-[11.5px] text-ink-faint">
              自定义供应商
            </div>
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => {
                  setSelectedId(provider.id);
                  setTestResult(null);
                }}
                className={`flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors ${
                  selected?.id === provider.id
                    ? "bg-card-hover"
                    : "hover:bg-card-hover/60"
                }`}
              >
                <Box
                  size={15}
                  strokeWidth={1.7}
                  className="shrink-0 text-ink-muted"
                />
                <ScrollText
                  text={provider.name}
                  className="min-w-0 flex-1 text-[13px] text-ink"
                />
                <span
                  className={`h-[6px] w-[6px] shrink-0 rounded-full ${provider.enabled ? "bg-ok" : "bg-ink-faint/60"}`}
                />
              </button>
            ))}

            <button
              type="button"
              onClick={() => void addProvider()}
              className="flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-ink-muted transition-colors hover:bg-card-hover hover:text-ink"
            >
              <Plus size={15} strokeWidth={1.9} className="shrink-0" />
              添加供应商
            </button>
          </Scroller>

          <Scroller
            className="min-w-0 flex-1"
            contentClassName="p-4 @2xl:p-6"
            fadeColor="var(--color-shell)"
          >
            {!selected ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <p className="text-[13px] text-ink-muted">
                  还没有配置任何供应商
                </p>
                <GhostButton onClick={() => void addProvider()}>
                  添加第一个供应商
                </GhostButton>
              </div>
            ) : (
              <ProviderEditor
                key={selected.id}
                provider={selected}
                defaultModelId={settings?.defaultModelId ?? null}
                testResult={testResult}
                testing={testing}
                onTest={() => void runTest()}
                onChange={(patch) => void updateProvider(selected.id, patch)}
                onRemove={() => void removeProvider(selected.id)}
                onEditModel={(model) =>
                  setEditingModel({ providerId: selected.id, model })
                }
                onRemoveModel={(modelId) =>
                  void removeModel(selected.id, modelId)
                }
                onSetDefault={(modelId) => {
                  if (settings)
                    void saveSettings({ ...settings, defaultModelId: modelId });
                }}
              />
            )}
          </Scroller>
        </div>
      </div>

      {editingModel && (
        <ModelEditor
          providerId={editingModel.providerId}
          model={editingModel.model}
          onCancel={() => setEditingModel(null)}
          onSave={(model) =>
            void saveModel(editingModel.providerId, model, editingModel.model)
          }
        />
      )}
    </div>
  );
}

function ProviderEditor({
  provider,
  defaultModelId,
  testResult,
  testing,
  onTest,
  onChange,
  onRemove,
  onEditModel,
  onRemoveModel,
  onSetDefault,
}: {
  provider: ProviderConfig;
  defaultModelId: string | null;
  testResult: ProviderTestResult | null;
  testing: boolean;
  onTest: () => void;
  onChange: (patch: Partial<ProviderConfig>) => void;
  onRemove: () => void;
  onEditModel: (model: ModelConfig | null) => void;
  onRemoveModel: (modelId: string) => void;
  onSetDefault: (modelId: string) => void;
}) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState(provider.apiKey);
  const [renaming, setRenaming] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 pb-6">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (name.trim() && name !== provider.name)
                onChange({ name: name.trim() });
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-input px-2.5 text-[17px] font-semibold text-ink focus:border-ink-faint"
          />
        ) : (
          <>
            <h2 className="text-[17px] font-semibold tracking-tight text-ink">
              {provider.name}
            </h2>
            <button
              type="button"
              data-dw-tip="重命名"
              onClick={() => setRenaming(true)}
              className="text-ink-faint transition-colors hover:text-ink"
            >
              <Pencil size={13.5} strokeWidth={1.8} />
            </button>
          </>
        )}

        <Badge tone={provider.enabled ? "ok" : "muted"}>
          {provider.enabled ? "已启用" : "已禁用"}
        </Badge>
        <GhostButton onClick={() => onChange({ enabled: !provider.enabled })}>
          {provider.enabled ? "禁用" : "启用"}
        </GhostButton>

        <div className="flex-1" />
        <button
          type="button"
          data-dw-tip="删除供应商"
          onClick={onRemove}
          className="text-ink-faint transition-colors hover:text-danger"
        >
          <Trash2 size={15} strokeWidth={1.8} />
        </button>
      </div>

      <div className="space-y-4">
        <Field
          label="Base URL"
          hint="例如 https://relay.example.com 或 https://relay.example.com/v1"
        >
          <TextInput
            value={baseUrl}
            // Committed on every keystroke, like the API key. Waiting for blur meant
            // "测试连接" clicked straight after typing tested the previous URL.
            onChange={(value) => {
              setBaseUrl(value);
              onChange({ baseUrl: value.trim() });
            }}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
          />
        </Field>

        <Field
          label="API 格式"
          hint="DeepWise 只对接 Responses 与 Anthropic Messages，不支持 Chat Completions。"
        >
          <Select
            value={provider.api}
            onChange={(api) => onChange({ api })}
            options={API_OPTIONS}
          />
        </Field>

        <Field label="API Key">
          <SecretInput
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              onChange({ apiKey: value });
            }}
            placeholder="sk-…"
          />
        </Field>
      </div>

      <div className="pt-6">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12.5px] text-ink-muted">模型列表</span>
          <GhostButton onClick={onTest} disabled={testing}>
            {testing ? "测试中…" : "测试连接"}
          </GhostButton>
        </div>

        <div className="space-y-2">
          {provider.models.map((model) => (
            <div
              key={model.id}
              className="flex h-[46px] items-center gap-3 rounded-[10px] border border-line bg-input px-3.5"
            >
              <ScrollText
                text={model.modelId}
                className="min-w-0 flex-1 font-mono text-[13px] text-ink"
              />
              {defaultModelId === model.id && <Badge tone="accent">默认</Badge>}
              <span className="rounded bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-ink-faint">
                {formatWindow(model.contextWindow)}
              </span>
              <button
                type="button"
                data-dw-tip="设为默认模型"
                onClick={() => onSetDefault(model.id)}
                className="text-ink-faint transition-colors hover:text-ink"
              >
                <Link2 size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                data-dw-tip="编辑"
                onClick={() => onEditModel(model)}
                className="text-ink-faint transition-colors hover:text-ink"
              >
                <Pencil size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                data-dw-tip="删除"
                onClick={() => onRemoveModel(model.id)}
                className="text-ink-faint transition-colors hover:text-danger"
              >
                <Trash2 size={14} strokeWidth={1.8} />
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => onEditModel(null)}
            className="flex h-[38px] items-center gap-2 rounded-[10px] border border-line px-3 text-[12.5px] text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
          >
            <Plus size={14} strokeWidth={1.9} />
            添加模型
          </button>
        </div>

        {testResult && (
          <div
            className={`mt-3 rounded-[10px] border px-3.5 py-2.5 text-[12.5px] ${
              testResult.ok
                ? "border-ok/35 bg-ok/8 text-ok"
                : "border-danger/35 bg-danger/8 text-danger"
            }`}
          >
            {testResult.message}
            {testResult.latencyMs > 0 && (
              <span className="opacity-70"> · {testResult.latencyMs} ms</span>
            )}
            {testResult.models && testResult.models.length > 0 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer opacity-80">
                  端点上报的模型（{testResult.models.length}）
                </summary>
                <Scroller
                  className="mt-1 max-h-[160px]"
                  contentClassName="font-mono text-[11.5px] opacity-80"
                  fadeColor="var(--color-card)"
                >
                  {testResult.models.join("\n")}
                </Scroller>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
