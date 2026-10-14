import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { cleanups } from "./fixtures/pi-ai.mjs";

// Resolve the extension's Pi import to a fixture so tests need no local Pi installation.
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

let sessionNumber = 0;
function setup(provider = "openai") {
	const handlers = new Map();
	let command;
	let completions;
	let status;
	const notifications = [];
	const sessionId = `session-${++sessionNumber}`;
	let idleWaits = 0;
	const ctx = {
		hasUI: true,
		model: { provider, id: "any-model" },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		isIdle: () => true,
		waitForIdle: async () => { idleWaits++; },
		ui: {
			// TPS rendering is covered separately; these tests check the speed icon.
			theme: { fg: (color, text) => color === "muted" ? "" : `${color}:${text}` },
			setStatus: (key, value) => {
				assert.equal(key, "openai-speed");
				status = value;
			},
			notify: (text) => notifications.push(text),
		},
	};
	openaiSpeed({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, definition) => {
			if (name === "tps") return;
			assert.equal(name, "openai-speed");
			command = definition.handler;
			completions = definition.getArgumentCompletions;
		},
	});
	const emit = (name, event = {}) => handlers.get(name)(event, ctx);
	emit("session_start");
	return {
		ctx, emit, notifications,
		command: (args) => command(args, ctx),
		completions,
		get status() { return status; },
		get notification() { return notifications.at(-1); },
		get cleanupCount() { return cleanups.filter((id) => id === sessionId).length; },
		get idleWaits() { return idleWaits; },
	};
}

test("argument completions include descriptions and complete full debug arguments", () => {
	const app = setup();
	const values = (prefix) => app.completions(prefix)?.map((item) => item.value) ?? null;
	assert.deepEqual(values(""), ["on", "ultrafast", "off", "status", "tps", "debug on", "debug off"]);
	assert.ok(app.completions("").every((item) => item.label && item.description));
	assert.deepEqual(values("u"), ["ultrafast"]);
	assert.deepEqual(values("  UL"), ["ultrafast"]);
	assert.deepEqual(values("o"), ["on", "off"]);
	assert.deepEqual(values("s"), ["status"]);
	assert.deepEqual(values("d"), ["debug on", "debug off"]);
	assert.deepEqual(values("debug "), ["debug on", "debug off"]);
	assert.deepEqual(values("debug of"), ["debug off"]);
	assert.equal(values("invalid"), null);
	assert.equal(values("on extra"), null);
	assert.equal(app.status, "dim:󰾆");
	assert.equal(app.notifications.length, 0);
});

test("explicit commands select icons; bare /openai-speed and status do not change mode", async () => {
	const app = setup();
	assert.equal(app.status, "dim:󰾆");
	for (const [args, icon, mode] of [["on", "accent:", "fast"], ["ultrafast", "warning:", "ultrafast"], ["off", "dim:󰾆", "off"]]) {
		const before = app.notifications.length;
		await app.command(args);
		assert.equal(app.notifications.length, before + 1);
		for (const query of ["", "status"]) {
			await app.command(query);
			assert.equal(app.status, icon);
			assert.equal(app.notification, `OpenAI speed: ${mode}.`);
		}
	}
});

test("speed changes reconnect only this session; queries and unchanged modes keep the connection", async () => {
	const app = setup("openai-codex");
	const other = setup("openai-codex");
	assert.equal(app.cleanupCount, 1);
	for (const command of ["", "status", "off", "debug on", "debug off", "invalid"]) {
		await app.command(command);
	}
	assert.equal(app.cleanupCount, 1);
	assert.equal(app.idleWaits, 0);
	for (const command of ["on", "ultrafast", "off"]) {
		await app.command(command);
		await app.command(command);
	}
	assert.equal(app.cleanupCount, 4);
	assert.equal(app.idleWaits, 3);
	assert.equal(other.cleanupCount, 1);
});

test("busy speed changes acknowledge immediately, then reconnect and apply the tier when idle", async () => {
	for (const [command, mode, icon, tier] of [
		["on", "fast", "accent:", "priority"],
		["ultrafast", "ultrafast", "warning:", "ultrafast"],
		["off", "off", "dim:󰾆", undefined],
	]) {
		const app = setup("openai-codex");
		if (command === "off") await app.command("on");
		const previousStatus = app.status;
		const previousTier = app.emit("before_provider_request", { payload: {} })?.service_tier;
		const cleanupsBefore = app.cleanupCount;
		const idle = Promise.withResolvers();
		app.ctx.isIdle = () => false;
		app.ctx.waitForIdle = () => idle.promise;
		const changing = app.command(command);
		assert.equal(app.notification, `OpenAI speed: ${mode} requested; waiting for Pi to become idle.`);
		assert.equal(app.cleanupCount, cleanupsBefore);
		assert.equal(app.status, previousStatus);
		assert.equal(app.emit("before_provider_request", { payload: {} })?.service_tier, previousTier);
		idle.resolve();
		await changing;
		assert.equal(app.notification, `OpenAI speed: ${mode}.`);
		assert.equal(app.cleanupCount, cleanupsBefore + 1);
		assert.equal(app.status, icon);
		assert.equal(app.emit("before_provider_request", { payload: {} })?.service_tier, tier);
	}
});

test("session start resets mode and cached resources; provider changes refresh the icon", async () => {
	const app = setup();
	await app.command("ultrafast");
	app.ctx.model.provider = "anthropic";
	app.emit("model_select");
	assert.equal(app.status, "dim:󰾆");
	app.ctx.model.provider = "openai-codex";
	app.emit("model_select");
	assert.equal(app.status, "warning:");
	const beforeReload = app.cleanupCount;
	app.emit("session_start");
	assert.equal(app.cleanupCount, beforeReload + 1);
	assert.equal(app.status, "dim:󰾆");
	assert.equal(app.emit("before_provider_request", { payload: {} }), undefined);
});

test("only OpenAI providers receive the selected tier; payload is not mutated", async () => {
	for (const provider of ["openai", "openai-codex", "anthropic"]) {
		const app = setup(provider);
		const payload = { model: "any-model", service_tier: "auto", input: [] };
		assert.equal(app.emit("before_provider_request", { payload }), undefined);
		for (const [args, tier] of [["on", "priority"], ["ultrafast", "ultrafast"]]) {
			await app.command(args);
			const result = app.emit("before_provider_request", { payload });
			assert.deepEqual(result, provider === "anthropic" ? undefined : { ...payload, service_tier: tier });
			assert.equal(payload.service_tier, "auto");
		}
		await app.command("off");
		assert.equal(app.emit("before_provider_request", { payload }), undefined);
	}
});

test("Codex routing hints match the selected tier before the payload hook runs", async () => {
	const app = setup("openai-codex");
	app.ctx.model.id = "gpt-6.1-sol";
	const cases = [
		["off", undefined, "model=gpt-6.1-sol"],
		["on", "priority", "model=gpt-6.1-sol;tier=priority"],
		["ultrafast", "ultrafast", "model=gpt-6.1-sol;tier=ultrafast"],
		["off", undefined, "model=gpt-6.1-sol"],
	];
	for (const [command, tier, hint] of cases) {
		await app.command(command);
		const headers = { "existing-header": "keep", "x-codex-routing-hint": "stale" };
		assert.equal(app.emit("before_provider_headers", { headers }), undefined);
		assert.deepEqual(headers, {
			"existing-header": "keep",
			"x-codex-routing-hint": hint,
		});
		const payload = { model: app.ctx.model.id };
		const result = app.emit("before_provider_request", { payload });
		assert.equal(result?.service_tier, tier);
	}
});

test("routing hints leave other providers untouched", async () => {
	for (const provider of ["openai", "anthropic"]) {
		const app = setup(provider);
		await app.command("ultrafast");
		await app.command("debug on");
		const headers = { "existing-header": "keep" };
		const count = app.notifications.length;
		app.emit("before_provider_headers", { headers });
		assert.deepEqual(headers, { "existing-header": "keep" });
		assert.equal(app.notifications.length, count);
	}
});

test("outgoing routing-hint debug output is opt-in", async () => {
	const app = setup("openai-codex");
	const event = { headers: {} };
	app.emit("before_provider_headers", event);
	assert.equal(app.notifications.length, 0);
	await app.command("ultrafast");
	await app.command("debug on");
	app.emit("before_provider_headers", event);
	assert.equal(app.notification, 'OpenAI speed: outgoing x-codex-routing-hint="model=any-model;tier=ultrafast"');
	await app.command("debug off");
	app.emit("before_provider_headers", event);
	assert.equal(app.notification, "OpenAI speed debug: off.");
});

function response(app, type, tier) {
	app.emit("provider_stream_event", {
		provider: app.ctx.model.provider,
		data: { type, response: { service_tier: tier } },
	});
}

test("debug prints requested and returned tiers without changing the selected icon", async () => {
	const app = setup("openai-codex");
	await app.command("ultrafast");
	await app.command("debug on");
	assert.equal(app.status, "warning:");
	app.emit("before_provider_request", { payload: {} });
	for (const type of ["response.completed", "response.done", "response.incomplete"]) {
		response(app, type, "priority");
		assert.equal(app.notification, "OpenAI speed: requested=ultrafast returned=priority");
	}
	response(app, "response.completed", undefined);
	assert.equal(app.notification, "OpenAI speed: requested=ultrafast returned=unknown");
	await app.command("off");
	app.emit("before_provider_request", { payload: { service_tier: "auto" } });
	response(app, "response.completed", "default");
	assert.equal(app.notification, "OpenAI speed: requested=auto returned=default");
	app.emit("before_provider_request", { payload: {} });
	response(app, "response.completed", undefined);
	assert.equal(app.notification, "OpenAI speed: requested=unset returned=unknown");
});

test("debug is opt-in, ignores unrelated events, and resets on session start", async () => {
	const app = setup();
	response(app, "response.completed", "priority");
	assert.equal(app.notifications.length, 0);
	await app.command("debug on");
	const count = app.notifications.length;
	response(app, "response.created", "priority");
	app.emit("provider_stream_event", {
		provider: "anthropic", data: { type: "response.completed" },
	});
	assert.equal(app.notifications.length, count);
	await app.command("debug off");
	response(app, "response.completed", "priority");
	assert.equal(app.notification, "OpenAI speed debug: off.");
	await app.command("debug on");
	app.emit("session_start");
	response(app, "response.completed", "priority");
	assert.equal(app.notification, "OpenAI speed debug: on.");
});
