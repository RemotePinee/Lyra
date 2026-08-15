import { EventBus, type Middleware, type Observer, type Responder } from "./events.ts";

/**
 * The repository every capability is found in.
 *
 * A plugin never imports the thing it needs. It names a key — `llm`, `tools`, `sessions` — and
 * takes whatever is registered under it, which is the entire point: the model adapter, the store,
 * the approval policy can each be swapped for another implementation without a line changing in
 * anything that uses them.
 *
 * Load order follows from that. A plugin that declares `inject: ["llm"]` is not started until an
 * `llm` exists, so nothing has to be sequenced by hand, and a capability arriving late simply
 * starts what was waiting for it.
 */
export interface ServiceMap {
	// Declared by the plugins that provide them; see `kernel/services.ts` for the seams we define.
	[key: string]: unknown;
}

export type Disposer = () => void | Promise<void>;

/** A plugin: something that installs capabilities into a context and can take them back out. */
export interface Plugin {
	name: string;
	/** Services this plugin cannot work without. It waits until every one of them exists. */
	inject?: string[];
	apply(ctx: Context): void | Disposer | Promise<void | Disposer>;
}

interface Pending {
	plugin: Plugin;
	dispose?: Disposer;
	active: boolean;
}

/**
 * A context: services, events, and the undo log that ties them together.
 *
 * Everything installed through a context is recorded so it can be reversed — that is what makes
 * a plugin swappable rather than merely present. A registration with no disposer is a leak that
 * only shows up the first time someone tries to reload.
 */
export class Context {
	readonly bus = new EventBus();
	private readonly services = new Map<string, unknown>();
	private readonly plugins: Pending[] = [];
	private readonly disposers: Disposer[] = [];
	private disposed = false;

	/** Register a capability under its key. Returns the disposer that withdraws it. */
	provide<T>(key: string, value: T): Disposer {
		if (this.services.has(key)) {
			throw new Error(`Service "${key}" is already provided; withdraw it before replacing it.`);
		}
		this.services.set(key, value);
		this.bus.emit("service/added", key);
		void this.startWaiting();

		const dispose = () => {
			if (this.services.get(key) !== value) return;
			this.services.delete(key);
			this.bus.emit("service/removed", key);
		};
		this.disposers.push(dispose);
		return dispose;
	}

	/** The capability registered under `key`, or undefined if nothing provides it. */
	get<T>(key: string): T | undefined {
		return this.services.get(key) as T | undefined;
	}

	/** As `get`, but for the many places where absence is a programming error rather than a state. */
	require<T>(key: string): T {
		const value = this.services.get(key);
		if (value === undefined) throw new Error(`Service "${key}" is not available.`);
		return value as T;
	}

	has(key: string): boolean {
		return this.services.has(key);
	}

	get provided(): string[] {
		return [...this.services.keys()];
	}

	/**
	 * Install a plugin.
	 *
	 * If its dependencies are not all present it is held until they are, so a configuration can
	 * list plugins in any order and still come up correctly.
	 */
	async use(plugin: Plugin): Promise<void> {
		const entry: Pending = { plugin, active: false };
		this.plugins.push(entry);
		await this.startWaiting();
	}

	/** Anything registered here is undone when the context is disposed. */
	effect(register: () => Disposer): Disposer {
		const dispose = register();
		this.disposers.push(dispose);
		return dispose;
	}

	on<A extends unknown[]>(event: string, listener: Observer<A>, options?: { prepend?: boolean }): Disposer {
		const off = this.bus.on(event, listener as never, options);
		this.disposers.push(off);
		return off;
	}

	/** A listener that may answer the question rather than merely hear it. */
	onSerial<A extends unknown[], R>(event: string, listener: Responder<A, R>): Disposer {
		const off = this.bus.on(event, listener as never);
		this.disposers.push(off);
		return off;
	}

	/** A listener that wraps the work: call `next()` to delegate, or return to decide. */
	onWaterfall<A extends unknown[], R>(
		event: string,
		listener: Middleware<A, R>,
		options?: { prepend?: boolean },
	): Disposer {
		const off = this.bus.on(event, listener as never, options);
		this.disposers.push(off);
		return off;
	}

	emit(event: string, ...args: unknown[]): void {
		this.bus.emit(event, ...args);
	}

	parallel(event: string, ...args: unknown[]): Promise<void> {
		return this.bus.parallel(event, ...args);
	}

	serial<R>(event: string, ...args: unknown[]): Promise<R | undefined> {
		return this.bus.serial<R>(event, ...args);
	}

	waterfall<R>(event: string, args: unknown[], base: () => Promise<R>): Promise<R> {
		return this.bus.waterfall<R>(event, args, base);
	}

	/** Unwind everything, newest first, so teardown mirrors the order things were built in. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of [...this.plugins].reverse()) {
			if (entry.active) await entry.dispose?.();
			entry.active = false;
		}
		for (const dispose of [...this.disposers].reverse()) await dispose();
		this.disposers.length = 0;
		this.services.clear();
	}

	/**
	 * Start every plugin whose dependencies have arrived.
	 *
	 * Looped rather than done in one pass: starting a plugin usually provides a service, which may
	 * be the last thing another plugin was waiting for. It settles when a full pass starts nothing.
	 */
	private async startWaiting(): Promise<void> {
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const entry of this.plugins) {
				if (entry.active) continue;
				const missing = (entry.plugin.inject ?? []).filter((key) => !this.services.has(key));
				if (missing.length > 0) continue;
				entry.active = true;
				const dispose = await entry.plugin.apply(this);
				if (typeof dispose === "function") entry.dispose = dispose;
				this.bus.emit("plugin/started", entry.plugin.name);
				progressed = true;
			}
		}
	}

	/** Plugins that are still waiting, and what for — the answer to "why is nothing happening". */
	pending(): { name: string; missing: string[] }[] {
		return this.plugins
			.filter((entry) => !entry.active)
			.map((entry) => ({
				name: entry.plugin.name,
				missing: (entry.plugin.inject ?? []).filter((key) => !this.services.has(key)),
			}));
	}
}
