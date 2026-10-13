import assert from "node:assert/strict";
import test from "node:test";
import openaiSpeed from "../extensions/openai-speed/index.ts";

function setup(provider = "openai") {
	const handlers = new Map();
	let command;
	let completions;
	let status;
	const notifications = [];
	const ctx = {
		model: { provider, id: "any-model" },
		ui: {
			theme: { fg: (color, text) => `${color}:${text}` },
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
		completions: (prefix) => completions(prefix),
		get status() { return status; },
		get notification() { return notifications.at(-1); },
	};
}

test("argument completions include descriptions and complete full debug arguments", () => {
	const app = setup();
	const values = (prefix) => app.completions(prefix)?.map((item) => item.value) ?? null;
	assert.deepEqual(values(""), ["on", "ultrafast", "off", "status", "debug on", "debug off"]);
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
		await app.command(args);
		for (const query of ["", "status"]) {
			await app.command(query);
			assert.equal(app.status, icon);
			assert.equal(app.notification, `OpenAI speed: ${mode}.`);
		}
	}
});

test("session start resets mode; provider changes refresh the icon", async () => {
	const app = setup();
	await app.command("ultrafast");
	app.ctx.model.provider = "anthropic";
	app.emit("model_select");
	assert.equal(app.status, "dim:󰾆");
	app.ctx.model.provider = "openai-codex";
	app.emit("model_select");
	assert.equal(app.status, "warning:");
	app.emit("session_start");
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
