/**
 * Is this provider reachable, and how quickly.
 *
 * A one-token request rather than a models listing: what the settings page is really asking is
 * whether a real request would work, and only a real request answers that.
 */

import type { ProviderTestResult, SyncStatus } from "./ipc-types.ts";
import { getProvider, type Settings } from "@deepwise/core";
import { getSettings } from "./app-settings.ts";

/** What sync looks like when it is not running: the port it would use, and nothing else. */
export function idleSyncStatus(): SyncStatus {
	const settings = getSettings();
	return {
		running: false,
		port: settings?.sync.port ?? 4517,
		token: settings?.sync.token ?? null,
		addresses: [],
		clients: 0,
		pairingUrl: null,
	};
}

/**
 * Probe a provider with a one-token request. A models listing is attempted first because it
 * is free, but many relays do not expose one, so a failure there is not treated as fatal.
 */
export async function testProvider(provider: Settings["providers"][number]): Promise<ProviderTestResult> {
	const started = Date.now();
	const base = provider.baseUrl.replace(/\/+$/, "");
	const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;

	let models: string[] | undefined;
	try {
		const listed = await fetch(modelsUrl, {
			headers:
				provider.api === "anthropic-messages"
					? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
					: { authorization: `Bearer ${provider.apiKey}` },
			signal: AbortSignal.timeout(15_000),
		});
		if (listed.ok) {
			const body = (await listed.json()) as { data?: { id?: string }[] };
			models = body.data?.map((m) => m.id ?? "").filter(Boolean).slice(0, 200);
		}
	} catch {
		models = undefined;
	}

	const model = provider.models[0];
	if (!model) {
		return models
			? { ok: true, latencyMs: Date.now() - started, message: `连接成功，发现 ${models.length} 个可用模型`, models }
			: { ok: false, latencyMs: Date.now() - started, message: "请先添加至少一个模型再测试" };
	}

	try {
		const isAnthropic = provider.api === "anthropic-messages";
		const response = await fetch(isAnthropic ? `${base}/v1/messages`.replace("/v1/v1/", "/v1/") : `${base}/v1/responses`.replace("/v1/v1/", "/v1/"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(isAnthropic
					? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
					: { authorization: `Bearer ${provider.apiKey}` }),
			},
			body: JSON.stringify(
				isAnthropic
					? { model: model.modelId, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }
					: { model: model.modelId, input: "hi", max_output_tokens: 16, stream: false, store: false },
			),
			signal: AbortSignal.timeout(30_000),
		});
		const latencyMs = Date.now() - started;
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 300);
			return { ok: false, latencyMs, message: `HTTP ${response.status}: ${detail}`, models };
		}
		return { ok: true, latencyMs, message: `连接成功，${model.name} 响应正常`, models };
	} catch (error) {
		return {
			ok: false,
			latencyMs: Date.now() - started,
			message: error instanceof Error ? error.message : String(error),
			models,
		};
	}
}
