import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import compact from "../extensions/pi-compact/index.ts";

const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

function fixture(mode = "tui") {
	const handlers = new Map();
	compact({ on: (event, handler) => handlers.set(event, handler) });
	const above = new Container();
	const below = new Container();
	const unrelated = new Container();
	const widgets = new Map();
	const notices = [];
	let renders = 0;
	const tui = { children: [unrelated, above, below], requestRender: () => renders++ };
	const rebuild = () => InteractiveMode.prototype.renderWidgetContainer.call({}, above, widgets, true, true);
	const ctx = {
		mode,
		ui: {
			setWidget(key, factory) {
				widgets.get(key)?.dispose?.();
				widgets.delete(key);
				if (factory) widgets.set(key, factory(tui));
				rebuild();
				tui.requestRender();
			},
			notify: (...args) => notices.push(args),
		},
	};
	rebuild();
	return { handlers, above, below, unrelated, widgets, notices, tui, ctx, rebuild, renders: () => renders };
}

const message = (text) => ({ render: () => [text], invalidate() {} });

test("Pi's extension loader accepts the standalone entry point", async () => {
	const path = fileURLToPath(new URL("../extensions/pi-compact/index.ts", import.meta.url));
	const loaded = await discoverAndLoadExtensions([path], process.cwd());
	assert.deepEqual(loaded.errors, []);
	assert.ok(loaded.extensions.some((extension) => extension.path === path));
});

test("removes only the above-editor spacer and preserves widgets through rebuilds", () => {
	const f = fixture();
	const originalAddChild = f.above.addChild;
	f.unrelated.addChild(message("unrelated"));
	f.below.addChild(message("below"));
	f.handlers.get("session_start")({}, f.ctx);
	assert.deepEqual(f.above.render(80), []);
	assert.deepEqual(f.notices, []);
	assert.ok(f.renders() > 0);
	f.widgets.set("other-extension", message("notification"));
	f.rebuild();
	assert.deepEqual(f.above.render(80), ["notification"]);
	f.above.invalidate();
	assert.deepEqual(f.above.render(20), ["notification"]);
	assert.deepEqual(f.unrelated.render(80), ["unrelated"]);
	assert.deepEqual(f.below.render(80), ["below"]);
	f.handlers.get("session_shutdown")({}, f.ctx);
	assert.equal(f.above.addChild, originalAddChild);
	assert.deepEqual(f.above.render(80), ["", "notification"]);
	f.handlers.get("session_shutdown")({}, f.ctx);
});

test("widget disposal restores the patch, and reload does not stack wrappers", () => {
	const f = fixture();
	const originalAddChild = f.above.addChild;
	f.handlers.get("session_start")({}, f.ctx);
	f.handlers.get("session_start")({}, f.ctx);
	assert.deepEqual(f.above.render(80), []);
	for (const widget of f.widgets.values()) widget.dispose?.();
	assert.equal(f.above.addChild, originalAddChild);
	assert.deepEqual(f.above.render(80), [""]);
	f.rebuild();
	assert.deepEqual(f.above.render(80), [""]);
});

test("patch follows the same container when renderers change", () => {
	const f = fixture();
	f.handlers.get("session_start")({}, f.ctx);
	const nextTui = { children: [...f.tui.children] };
	f.tui.children = [];
	f.rebuild();
	assert.ok(nextTui.children.includes(f.above));
	assert.deepEqual(f.above.render(80), []);
	f.handlers.get("session_shutdown")({}, f.ctx);
});

test("non-terminal modes do not install widgets", () => {
	for (const mode of ["rpc", "print", "json"]) {
		const f = fixture(mode);
		f.handlers.get("session_start")({}, f.ctx);
		assert.equal(f.widgets.size, 0);
		assert.deepEqual(f.above.render(80), [""]);
	}
});

test("warns without patching when Pi no longer inserts a Spacer", () => {
	const f = fixture();
	const originalAddChild = f.above.addChild;
	f.ctx.ui.setWidget = (key, factory) => {
		f.widgets.get(key)?.dispose?.();
		f.widgets.delete(key);
		f.above.clear();
		f.above.addChild(message("different layout"));
		if (factory) {
			const anchor = factory(f.tui);
			f.widgets.set(key, anchor);
			f.above.addChild(anchor);
		}
	};
	f.handlers.get("session_start")({}, f.ctx);
	assert.equal(f.above.addChild, originalAddChild);
	assert.deepEqual(f.above.render(80), ["different layout"]);
	assert.equal(f.widgets.size, 0);
	assert.match(f.notices[0][0], /unsupported Pi layout/);
});

test("warns without modifying the layout when the anchor container is missing", () => {
	const f = fixture();
	f.tui.children = [];
	const originalAddChild = f.above.addChild;
	f.handlers.get("session_start")({}, f.ctx);
	assert.equal(f.widgets.size, 0);
	assert.equal(f.above.addChild, originalAddChild);
	assert.deepEqual(f.above.render(80), [""]);
	assert.match(f.notices[0][0], /unsupported Pi layout/);
	assert.equal(f.notices[0][1], "warning");
});
