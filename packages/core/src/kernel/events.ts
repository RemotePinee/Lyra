/**
 * The four ways a capability can be talked to.
 *
 * A capability that only announces things needs nothing more than `emit`. One that lets others
 * change an answer needs `waterfall`, and the difference matters enough to be part of the event's
 * public contract rather than a detail of how it happens to be dispatched today: a listener
 * written for one mode is wrong under another.
 */
export type Dispatch = "emit" | "parallel" | "serial" | "waterfall";

/** A listener for `emit` and `parallel`: observes, returns nothing anyone reads. */
export type Observer<A extends unknown[]> = (...args: A) => void | Promise<void>;

/** A listener for `serial`: observes in turn and may answer. */
export type Responder<A extends unknown[], R> = (...args: A) => R | undefined | Promise<R | undefined>;

/**
 * A listener for `waterfall`: around-middleware.
 *
 * It receives the arguments plus `next`. Calling `next()` passes the (possibly altered) work to
 * whoever registered after it and yields their answer; returning without calling it stops there
 * and the answer is this listener's own. That is how a policy can own a decision outright while
 * an observer merely annotates and delegates.
 */
export type Middleware<A extends unknown[], R> = (...args: [...A, () => Promise<R>]) => R | Promise<R>;

type AnyListener = (...args: never[]) => unknown;

interface Registration {
	listener: AnyListener;
	prepend: boolean;
}

/**
 * A typed event bus.
 *
 * Deliberately small: registration returns its own disposer, because a plugin that is unloaded
 * must be able to take everything it installed with it. Anything that cannot be undone has no
 * place in a system whose whole premise is that capabilities are swappable.
 */
export class EventBus {
	private readonly listeners = new Map<string, Registration[]>();

	on(event: string, listener: AnyListener, options: { prepend?: boolean } = {}): () => void {
		const list = this.listeners.get(event) ?? [];
		const registration: Registration = { listener, prepend: options.prepend === true };
		if (registration.prepend) list.unshift(registration);
		else list.push(registration);
		this.listeners.set(event, list);

		return () => {
			const current = this.listeners.get(event);
			if (!current) return;
			const at = current.indexOf(registration);
			if (at >= 0) current.splice(at, 1);
		};
	}

	/** Fire and forget, in registration order. A throwing listener must not stop the others. */
	emit(event: string, ...args: unknown[]): void {
		for (const { listener } of this.snapshot(event)) {
			try {
				void (listener as (...a: unknown[]) => unknown)(...args);
			} catch {
				// An observer's failure is its own; the thing being announced still happened.
			}
		}
	}

	/** Everyone at once, awaited together. */
	async parallel(event: string, ...args: unknown[]): Promise<void> {
		await Promise.all(
			this.snapshot(event).map(async ({ listener }) => {
				try {
					await (listener as (...a: unknown[]) => unknown)(...args);
				} catch {
					// As above: one listener failing does not cancel the rest.
				}
			}),
		);
	}

	/** In turn, until one answers. The first defined result wins and the rest are not asked. */
	async serial<R>(event: string, ...args: unknown[]): Promise<R | undefined> {
		for (const { listener } of this.snapshot(event)) {
			const result = (await (listener as (...a: unknown[]) => unknown)(...args)) as R | undefined;
			if (result !== undefined) return result;
		}
		return undefined;
	}

	/**
	 * Around-middleware, ending in `base`.
	 *
	 * Built back to front so the first registered listener is the outermost: it sees the request
	 * first and the answer last, which is what "wrapping" has to mean for a chain to compose.
	 */
	async waterfall<R>(event: string, args: unknown[], base: () => Promise<R>): Promise<R> {
		const chain = this.snapshot(event);
		let next = base;
		for (let i = chain.length - 1; i >= 0; i--) {
			const listener = chain[i].listener as (...a: unknown[]) => Promise<R>;
			const downstream = next;
			next = () => listener(...args, downstream);
		}
		return next();
	}

	/** Listeners can register or dispose during dispatch; iterate a copy so that is safe. */
	private snapshot(event: string): Registration[] {
		return [...(this.listeners.get(event) ?? [])];
	}
}
