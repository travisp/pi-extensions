import assert from "node:assert/strict";
import test from "node:test";
import openaiSpeed from "../extensions/openai-speed/index.ts";

function setup(provider = "openai") {
	const handlers = new Map();
	let command;
	let status;
	let notification;
	const ctx = {
		model: { provider, id: "any-model" },
		ui: {
			theme: { fg: (color, text) => `${color}:${text}` },
			setStatus: (key, value) => {
				assert.equal(key, "openai-speed");
				status = value;
			},
			notify: (text) => { notification = text; },
		},
	};
	openaiSpeed({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, definition) => {
			assert.equal(name, "fast");
			command = definition.handler;
		},
	});
	const emit = (name, event = {}) => handlers.get(name)(event, ctx);
	emit("session_start");
	return {
		ctx, emit,
		command: (args) => command(args, ctx),
		get status() { return status; },
		get notification() { return notification; },
	};
}

test("explicit commands select icons; bare /fast and status do not change mode", async () => {
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
