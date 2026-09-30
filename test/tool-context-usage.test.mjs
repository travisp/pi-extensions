import assert from "node:assert/strict";
import test from "node:test";
import { installRenderPatch } from "../extensions/tool-context-usage/render-patch.mjs";

function fixture() {
	const prototype = { render() { return this.lines; } };
	const original = prototype.render;
	const options = {
		estimateResult: (content) => Math.ceil(content.map((c) => c.text ?? "").join("").length / 4),
		format: (text, width) => text.slice(0, width).padEnd(width),
	};
	const row = Object.assign(Object.create(prototype), {
		toolName: "read", toolCallId: "id", args: { path: "x" }, isPartial: false, expanded: false,
		result: { content: [{ type: "text", text: "x".repeat(400) }] },
		toolDefinition: {}, lines: ["read x", ""],
	});
	return { prototype, original, options, row };
}

test("counts arguments and full returned content without mutating result or renderer output", () => {
	const { prototype, options, row } = fixture();
	const dispose = installRenderPatch(prototype, options);
	const before = JSON.stringify(row.result);
	const expected = Math.ceil(("read".length + JSON.stringify(row.args).length) / 4) + 100;
	assert.match(row.render(100).join("\n"), new RegExp(`~${expected} context tokens`));
	assert.deepEqual(row.lines, ["read x", ""]);
	assert.equal(JSON.stringify(row.result), before);
	row.expanded = true;
	assert.match(row.render(100).join("\n"), /args ~\d+ · result ~100/);
	dispose();
});

test("background formatting includes trailing padding and truncated timing rows", () => {
	const { prototype, options, row } = fixture();
	const styled = [];
	const format = options.format;
	options.format = (text, width) => {
		const padded = format(text, width);
		styled.push(padded);
		return `\x1b[44m${padded}\x1b[49m`;
	};
	const dispose = installRenderPatch(prototype, options);
	row.render(80);
	assert.equal(styled.at(-1).length, 80);
	assert.match(styled.at(-1), /context tokens +$/);
	row.toolName = "bash";
	row.rendererState = { startedAt: 0 };
	row.lines = ["Took 1.0s", ""];
	row.render(80);
	assert.equal(styled.at(-1).length, 80);
	assert.match(styled.at(-1), /Took 1.0s · ~\d+ context tokens +$/);
	const narrow = row.render(12)[0];
	assert.equal(styled.at(-1).length, 12);
	assert.ok(narrow.endsWith("\x1b[49m"), "background reset survives truncation");
	dispose();
});

test("partial, hidden, and unrelated tool rows remain untouched", () => {
	const { prototype, options, row } = fixture();
	const dispose = installRenderPatch(prototype, options);
	row.isPartial = true;
	assert.equal(row.render(100), row.lines);
	row.isPartial = false;
	row.toolName = "custom";
	assert.equal(row.render(100), row.lines);
	row.toolName = "read";
	row.lines = [];
	assert.equal(row.render(100), row.lines);
	dispose();
});

test("bash extends only its final timing row; annotation fits narrow widths", () => {
	const { prototype, options, row } = fixture();
	const dispose = installRenderPatch(prototype, options);
	row.toolName = "bash";
	row.rendererState = { startedAt: 0 };
	row.lines = ["Took 999s", "other output", "", "Took 1.0s", ""];
	const output = row.render(100);
	assert.equal(output.length, row.lines.length);
	assert.equal(output[0], "Took 999s");
	assert.match(output[3], /Took 1.0s · ~\d+ context tokens/);
	assert.ok(row.render(12).every((line) => line.length <= 12));
	dispose();
});

test("reload leases do not double decorate and restore the original method", () => {
	const { prototype, original, options, row } = fixture();
	const first = installRenderPatch(prototype, options);
	const second = installRenderPatch(prototype, options);
	assert.equal(row.render(100).join("\n").match(/context tokens/g).length, 1);
	first();
	assert.match(row.render(100).join("\n"), /context tokens/);
	second();
	second();
	assert.equal(prototype.render, original);
	const third = installRenderPatch(prototype, options);
	assert.equal(row.render(100).join("\n").match(/context tokens/g).length, 1);
	third();
	assert.equal(prototype.render, original);
});

test("cleanup preserves a later patch and disables our annotation in its chain", () => {
	const { prototype, options, row } = fixture();
	const dispose = installRenderPatch(prototype, options);
	const ours = prototype.render;
	const later = function (width) { return [...ours.call(this, width), "other patch"]; };
	prototype.render = later;
	dispose();
	assert.equal(prototype.render, later);
	assert.deepEqual(row.render(100), [...row.lines, "other patch"]);
	const reload = installRenderPatch(prototype, options);
	assert.equal(row.render(100).join("\n").match(/context tokens/g).length, 1);
	reload();
	assert.equal(prototype.render, later);
});

test("a replaced final result is re-estimated", () => {
	const { prototype, options, row } = fixture();
	const dispose = installRenderPatch(prototype, options);
	const first = row.render(100).join("\n");
	row.result = { content: [{ type: "text", text: "short" }] };
	assert.notEqual(row.render(100).join("\n"), first);
	dispose();
});
