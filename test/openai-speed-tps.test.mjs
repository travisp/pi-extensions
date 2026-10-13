import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

const mockAiUrl = new URL("./fixtures/pi-ai.mjs", import.meta.url).href;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		return specifier === "@earendil-works/pi-ai"
			? { url: mockAiUrl, shortCircuit: true }
			: nextResolve(specifier, context);
	},
});
const { default: openaiSpeed } = await import("../extensions/openai-speed/index.ts");
hooks.deregister();

function setup(t) {
	let now = 0;
	t.mock.method(performance, "now", () => now);
	const handlers = new Map();
	const entries = [];
	let branch = entries;
	let status;
	let command;
	let speedCommand;
	let notification;
	const ctx = {
		hasUI: true,
		model: { provider: "openai-codex", id: "codex" },
		sessionManager: { getBranch: () => branch, getSessionId: () => "tps-test" },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (key, text) => { assert.equal(key, "openai-speed"); status = text; },
			notify: (text) => { notification = text; },
		},
	};
	openaiSpeed({
		on: (name, handler) => handlers.set(name, handler),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		registerCommand: (name, definition) => {
			if (name === "tps") command = definition.handler;
			else speedCommand = definition.handler;
		},
	});
	const emit = (name, event = {}) => handlers.get(name)(event, ctx);
	emit("session_start");
	return {
		ctx, emit, entries,
		advance: (ms) => { now += ms; },
		start: () => emit("before_provider_request", { payload: {} }),
		finish: (tokens, extra = {}) => emit("message_end", { message: {
			role: "assistant", provider: "openai-codex", model: "codex",
			stopReason: "stop", usage: { output: tokens, reasoning: tokens / 2 }, ...extra,
		} }),
		restore: (saved) => { branch = saved; emit("session_start"); },
		command: async () => { await command("", ctx); return notification; },
		toggle: () => speedCommand("tps", ctx),
		get widget() { return status; },
		get status() { return status.match(/TPS .*/)?.[0]; },
	};
}

test("footer shows latest request TPS while the command shows session averages", async (t) => {
	const app = setup(t);
	assert.equal(app.status, "TPS -");
	assert.equal(await app.command(), "No completed requests yet.");
	app.start();
	app.advance(10_000);
	app.finish(1000);
	assert.equal(app.status, "TPS 100.0");
	app.start();
	app.advance(30_000);
	app.finish(1000);
	assert.equal(app.status, "TPS 33.3");
	assert.equal(await app.command(), "openai-codex/codex: 50.0 TPS · 2 requests · 2000 tokens");
});

test("tools, idle time, and tool result messages do not count", (t) => {
	const app = setup(t);
	app.start();
	app.advance(1000);
	app.finish(100);
	app.advance(60_000);
	app.emit("message_end", { message: { role: "toolResult" } });
	app.start();
	app.advance(1000);
	app.finish(100, { stopReason: "toolUse" });
	assert.equal(app.status, "TPS 100.0");
	assert.equal(app.entries.length, 2);
});

test("reported tiers and models are kept separate", async (t) => {
	const app = setup(t);
	app.start();
	app.emit("provider_stream_event", { provider: "openai-codex", data: { type: "response.created" } });
	app.advance(1000);
	app.emit("provider_stream_event", { provider: "openai-codex", data: { type: "response.done", response: { service_tier: "priority" } } });
	app.finish(100);
	app.start();
	app.advance(1000);
	app.emit("provider_stream_event", { provider: "openai-codex", data: { type: "response.done", response: { service_tier: "ultrafast" } } });
	app.finish(200);
	app.start();
	app.advance(1000);
	app.finish(300, { model: "other" });
	assert.equal(app.status, "TPS 300.0");
	assert.equal(await app.command(), [
		"openai-codex/codex [priority]: 100.0 TPS · 1 requests · 100 tokens",
		"openai-codex/codex [ultrafast]: 200.0 TPS · 1 requests · 200 tokens",
		"openai-codex/other: 300.0 TPS · 1 requests · 300 tokens",
	].join("\n"));
});

test("failed, aborted, and untracked messages are skipped without leaking timing", (t) => {
	const app = setup(t);
	for (const stopReason of ["error", "aborted"]) {
		app.start();
		app.advance(1000);
		app.finish(100, { stopReason });
	}
	app.finish(100);
	assert.equal(app.status, "TPS -");
	assert.equal(app.entries.length, 0);
});

test("restores saved measurements on the active branch and resets on a new session", (t) => {
	const app = setup(t);
	app.start();
	app.advance(1000);
	app.finish(100);
	const saved = [...app.entries, { type: "custom", customType: "unrelated", data: {} }];
	app.restore(saved);
	assert.equal(app.status, "TPS 100.0");
	app.restore(saved);
	assert.equal(app.status, "TPS 100.0");
	app.start();
	app.restore([]);
	app.advance(1000);
	app.finish(100);
	assert.equal(app.status, "TPS -");
});

test("TPS toggle shares the speed widget and keeps measuring while hidden", async (t) => {
	const app = setup(t);
	assert.equal(app.widget, "󰾆 TPS -");
	await app.toggle();
	assert.equal(app.widget, "󰾆");
	app.start();
	app.advance(1000);
	app.finish(100);
	assert.equal(app.widget, "󰾆");
	await app.toggle();
	assert.equal(app.widget, "󰾆 TPS 100.0");
	await app.toggle();
	app.restore(app.entries);
	assert.equal(app.widget, "󰾆 TPS 100.0");
});

test("other providers do not record or display TPS", (t) => {
	const app = setup(t);
	app.ctx.model.provider = "anthropic";
	app.emit("model_select");
	app.start();
	app.advance(1000);
	app.finish(100, { provider: "anthropic" });
	assert.equal(app.widget, "󰾆");
	assert.equal(app.entries.length, 0);
});

test("records measurements without UI, including completed zero-token requests", async (t) => {
	const app = setup(t);
	app.ctx.hasUI = false;
	app.start();
	app.advance(1000);
	app.finish(0);
	assert.equal(app.entries.length, 1);
	assert.equal(await app.command(), "openai-codex/codex: 0.0 TPS · 1 requests · 0 tokens");
});
