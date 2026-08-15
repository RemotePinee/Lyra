import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "../src/kernel/context.ts";
import { createContext, LLM, TOOLS, type LlmRegistry, type ToolRegistry } from "../src/kernel/index.ts";

test("a plugin waits for the services it names, whatever order it was listed in", async () => {
	const ctx = new Context();
	const order: string[] = [];

	// The consumer is registered first and must still start second.
	await ctx.use({
		name: "consumer",
		inject: ["thing"],
		apply(c) {
			order.push(`consumer saw ${c.require<string>("thing")}`);
		},
	});
	assert.deepEqual(order, [], "nothing to consume yet");
	assert.deepEqual(ctx.pending(), [{ name: "consumer", missing: ["thing"] }]);

	await ctx.use({
		name: "provider",
		apply(c) {
			order.push("provider started");
			return c.provide("thing", "a value");
		},
	});

	assert.deepEqual(order, ["provider started", "consumer saw a value"]);
	assert.deepEqual(ctx.pending(), []);
});

test("disposing a context unwinds everything it installed", async () => {
	const ctx = new Context();
	const events: string[] = [];

	await ctx.use({
		name: "thing",
		apply(c) {
			const off = c.provide("thing", 1);
			return () => {
				off();
				events.push("disposed");
			};
		},
	});

	assert.equal(ctx.has("thing"), true);
	await ctx.dispose();
	assert.deepEqual(events, ["disposed"]);
	assert.equal(ctx.has("thing"), false);
});

test("a service cannot be provided twice under the same key", async () => {
	const ctx = new Context();
	ctx.provide("thing", 1);
	assert.throws(() => ctx.provide("thing", 2), /already provided/);
});

test("emit reaches every listener, and one that throws does not stop the others", async () => {
	const ctx = new Context();
	const seen: string[] = [];
	ctx.on("x", () => {
		throw new Error("bad listener");
	});
	ctx.on("x", (value: unknown) => {
		seen.push(String(value));
	});
	ctx.emit("x", 42);
	assert.deepEqual(seen, ["42"]);
});

test("serial stops at the first listener with an answer", async () => {
	const ctx = new Context();
	const asked: string[] = [];
	ctx.onSerial<[], string>("q", () => {
		asked.push("first");
		return undefined;
	});
	ctx.onSerial<[], string>("q", () => {
		asked.push("second");
		return "answer";
	});
	ctx.onSerial<[], string>("q", () => {
		asked.push("third");
		return "never reached";
	});

	assert.equal(await ctx.serial<string>("q"), "answer");
	assert.deepEqual(asked, ["first", "second"]);
});

test("waterfall wraps: the first listener registered is the outermost", async () => {
	const ctx = new Context();
	const trace: string[] = [];

	ctx.onWaterfall<[string], string>("w", async (value, next) => {
		trace.push(`outer in ${value}`);
		const result = await next();
		trace.push("outer out");
		return `[${result}]`;
	});
	ctx.onWaterfall<[string], string>("w", async (value, next) => {
		trace.push(`inner in ${value}`);
		return `(${await next()})`;
	});

	const result = await ctx.waterfall<string>("w", ["v"], async () => "base");
	assert.equal(result, "[(base)]");
	assert.deepEqual(trace, ["outer in v", "inner in v", "outer out"]);
});

test("a waterfall listener that does not delegate owns the decision", async () => {
	const ctx = new Context();
	let baseRan = false;
	ctx.onWaterfall<[], string>("w", async () => "decided");
	ctx.onWaterfall<[], string>("w", async (next) => {
		baseRan = true;
		return next();
	});

	assert.equal(await ctx.waterfall<string>("w", [], async () => "base"), "decided");
	assert.equal(baseRan, false, "downstream is never asked once someone answers");
});

test("the default context provides the seams the app is built on", async () => {
	const ctx = await createContext();
	assert.deepEqual(ctx.pending(), [], "nothing left waiting");

	const llm = ctx.require<LlmRegistry>(LLM);
	assert.deepEqual(llm.list().sort(), ["anthropic-messages", "openai-responses"]);

	const tools = ctx.require<ToolRegistry>(TOOLS);
	assert.ok(tools.byName("bash"), "the shell tool is registered");
	assert.ok(tools.byName("read"), "the file tools are registered");
	assert.ok(tools.all().length >= 13);

	await ctx.dispose();
});

test("a later registration replaces a tool of the same name", async () => {
	const ctx = await createContext();
	const tools = ctx.require<ToolRegistry>(TOOLS);
	const original = tools.byName("bash");

	const remove = tools.register([{ ...(original as never), description: "sandboxed" } as never]);
	assert.equal(tools.byName("bash")?.description, "sandboxed");
	// And withdrawing the replacement restores what it displaced.
	remove();
	assert.equal(tools.byName("bash"), original);

	await ctx.dispose();
});
