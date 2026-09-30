import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, initTheme } from "@earendil-works/pi-coding-agent";

initTheme();
const { theme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const path = fileURLToPath(new URL("../extensions/codemode-collapse-fix/index.ts", import.meta.url));
const loaded = await discoverAndLoadExtensions([path], process.cwd());
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions.find((extension) => extension.path === path).tools.get("codemode").definition;
const context = { state: {}, showImages: false, isError: false, expanded: false };
const result = (text) => ({ content: [{ type: "text", text }], details: { calls: [] } });

test("long single-line output is bounded after wrapping and expansion retains it", () => {
	const output = "x".repeat(12000);
	for (const width of [20, 80, 120]) {
		const collapsed = tool.renderResult(result(output), { expanded: false, isPartial: false }, theme, context);
		assert.ok(collapsed.render(width).length <= 17);
		assert.match(collapsed.render(width).join("\n"), /expand/);
		const expanded = tool.renderResult(result(output), { expanded: true, isPartial: false }, theme, context);
		assert.ok(expanded.render(width).length > 17);
		assert.equal(expanded.render(width).join("").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s/g, ""), output);
	}
});

test("resize and invalidate recalculate the visible-row limit", () => {
	const component = tool.renderResult(result("x".repeat(200)), { expanded: false, isPartial: false }, theme, context);
	assert.ok(component.render(80).length < 17);
	assert.ok(component.render(8).length <= 17);
	component.invalidate();
	assert.ok(component.render(80).length < 17);
});

test("long script is bounded and full-output file remains discoverable", () => {
	const call = tool.renderCall({ code: "x".repeat(12000) }, theme, context);
	assert.ok(call.render(80).length <= 12);
	const value = result("x".repeat(12000));
	value.details.fullOutputPath = "/tmp/codemode-output.txt";
	const component = tool.renderResult(value, { expanded: false, isPartial: false }, theme, context);
	assert.match(component.render(80).join("\n"), /Full output: \/tmp\/codemode-output.txt/);
});
