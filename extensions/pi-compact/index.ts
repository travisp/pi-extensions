import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Container, Spacer, TUI } from "@earendil-works/pi-tui";
const WIDGET_KEY = "pi-compact-anchor";

/** Patch only the above-editor container, including spacers recreated by widget updates. */
function compactContainer(container: Container): (() => void) | undefined {
	const spacer = container.children[0] as Spacer | undefined;
	if (spacer?.constructor.name !== "Spacer" || typeof spacer.setLines !== "function") {
		return undefined;
	}

	// Use Pi's own constructor: an extension can resolve a different copy of pi-tui.
	const spacerClass = spacer.constructor;
	const originalAddChild = container.addChild;
	const addChild: Container["addChild"] = function (this: Container, component) {
		if (this.children.length === 0 && component.constructor === spacerClass) {
			(component as Spacer).setLines(0);
		}
		originalAddChild.call(this, component);
	};
	container.addChild = addChild;
	spacer.setLines(0);

	return () => {
		if (container.addChild === addChild) container.addChild = originalAddChild;
		const current = container.children[0];
		if (current?.constructor === spacerClass) (current as Spacer).setLines(1);
	};
}

export default function (pi: ExtensionAPI) {
	let cleanup: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		cleanup?.();
		cleanup = undefined;
		if (ctx.mode !== "tui") return;

		let tui!: TUI;
		let restore: (() => void) | undefined;
		const anchor = {
			render: () => [],
			invalidate() {},
			dispose() {
				restore?.();
				restore = undefined;
			},
		};

		ctx.ui.setWidget(WIDGET_KEY, (activeTui) => {
			tui = activeTui;
			return anchor;
		}, { placement: "aboveEditor" });

		// setWidget attaches the anchor after calling its factory. Search only after it returns.
		const container = tui.children.find((component) =>
			"children" in component && (component as Container).children.includes(anchor),
		) as Container | undefined;
		if (container) restore = compactContainer(container);
		if (!restore) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.notify("pi-compact: unsupported Pi layout; above-editor container or spacer not found", "warning");
			return;
		}

		// setWidget already schedules a redraw, including when removing the anchor.
		cleanup = () => ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.on("session_shutdown", () => {
		cleanup?.();
		cleanup = undefined;
	});
}
