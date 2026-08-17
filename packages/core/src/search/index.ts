/**
 * Asking the web a question, without the tool knowing who answers it.
 *
 * Search services are the part of this that will change: one gets an API, one gets a paywall, one
 * turns out to return better results for code. What must not change when they do is how the model
 * asks — so the model-facing tool is one thing, the providers are another, and this is the seam
 * between them.
 *
 * The shape follows what the reference implementation arrived at after three genuinely different
 * backends (a search API, a chat model with citations, a model with a native search tool). Two
 * details of it are load-bearing:
 *
 * `available()` is a **local** check — is there a key, does the config parse — and must not touch
 * the network. Selection happens on every call, and a selection that made an HTTP request would
 * put a probe in front of every search.
 *
 * Selection never depends on registration order. A configured id wins; with no id and exactly one
 * usable provider, that one wins; with several and no id, it is an error rather than a coin toss.
 * "Whichever plugin loaded first" is not a decision anybody made.
 */

export interface SearchSource {
	url: string;
	title?: string;
	snippet?: string;
	/** Publication or crawl time, as the provider spelled it. */
	publishedAt?: string;
}

export interface SearchResult {
	/**
	 * A generated answer, when the provider makes one.
	 *
	 * Some do (a chat model with citations), some do not (a plain search API). Optional rather
	 * than invented: an empty summary is honest, a fabricated one is not.
	 */
	content?: string;
	sources: SearchSource[];
	/** Set when the seam cut the list down to `maxResults`. */
	truncated: boolean;
}

export interface SearchRequest {
	query: string;
	/**
	 * Upper bound on sources, enforced by the seam on the way back.
	 *
	 * Deliberately not a model-facing argument. It is a cost and context-budget decision that
	 * belongs to whoever configured the app, and a model asking for fifty results is describing a
	 * budget it cannot see.
	 */
	maxResults?: number;
	signal?: AbortSignal;
}

export interface SearchProvider {
	/** Registry key, and what a config points at. */
	id: string;
	/** Human-facing name for settings. */
	name: string;
	/**
	 * Whether this provider could run right now — key present, config parseable.
	 *
	 * Local only. No network.
	 */
	available(): boolean;
	search(request: SearchRequest): Promise<SearchResult>;
}

/** Why a search could not run. Open on purpose: a provider may raise its own codes. */
export class SearchError extends Error {
	readonly code: string;
	constructor(message: string, code: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SearchError";
		this.code = code;
	}
}

const providers = new Map<string, SearchProvider>();

/** Register one provider. Returns the disposer, so a plugin can take it back. */
export function registerSearchProvider(provider: SearchProvider): () => void {
	if (providers.has(provider.id)) {
		throw new SearchError(`搜索提供方 ${provider.id} 已经注册过了`, "SEARCH_DUPLICATE_PROVIDER");
	}
	providers.set(provider.id, provider);
	return () => {
		providers.delete(provider.id);
	};
}

/** Every registered provider, for settings to list. */
export function searchProviders(): SearchProvider[] {
	return [...providers.values()];
}

/** Forget all of them. Tests only. */
export function resetSearchProviders(): void {
	providers.clear();
}

/**
 * The provider one search will use.
 *
 * Every failure is its own code, because the fixes are different: a name that is not registered is
 * a typo, a name that is registered but unusable is a missing key, and several usable ones with no
 * choice made is a configuration that has not been finished.
 */
export function selectSearchProvider(configuredId?: string | null): SearchProvider {
	if (configuredId) {
		const chosen = providers.get(configuredId);
		if (!chosen) throw new SearchError(`没有注册过叫 ${configuredId} 的搜索提供方`, "SEARCH_PROVIDER_MISSING");
		if (!chosen.available()) {
			throw new SearchError(`搜索提供方 ${configuredId} 还不能用（多半是没填 key）`, "SEARCH_PROVIDER_UNAVAILABLE");
		}
		return chosen;
	}
	const usable = [...providers.values()].filter((provider) => provider.available());
	if (usable.length === 0) throw new SearchError("没有可用的搜索提供方", "SEARCH_PROVIDER_UNAVAILABLE");
	if (usable.length > 1) {
		throw new SearchError(
			`有多个可用的搜索提供方（${usable.map((p) => p.id).join("、")}），请在设置里指定用哪个`,
			"SEARCH_PROVIDER_AMBIGUOUS",
		);
	}
	return usable[0];
}

/**
 * Run one search through the selected provider, and hold it to the bound.
 *
 * The truncation is here rather than trusted to each provider: a bound that every adapter has to
 * remember is one that some adapter will not.
 */
export async function search(request: SearchRequest, configuredId?: string | null): Promise<SearchResult> {
	const provider = selectSearchProvider(configuredId);
	const result = await provider.search(request);
	const limit = request.maxResults;
	if (limit !== undefined && result.sources.length > limit) {
		return { ...result, sources: result.sources.slice(0, limit), truncated: true };
	}
	return result;
}
