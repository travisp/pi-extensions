import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, Container, Spacer, TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-compact-anchor";
const COMPACT_BELOW_ROWS = 40;

/** Patch only the above-editor container, including spacers recreated by widget updates. */
function compactEditor(container: Container): (() => void) | undefined {
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

type LayoutComponent = Component & {
	children?: Component[];
	child?: Component;
	paddingY?: number;
	lines?: number;
};

/** Adjust layout properties rather than trimming rendered lines, which may contain real content. */
function compactTranscript(chat: Container, terminal: TUI["terminal"]): () => void {
	const originalRender = chat.render;
	const originalSpacing = new WeakMap<Component, number>();

	function setTreeSpacing(component: LayoutComponent, compact: boolean) {
		const property = component.constructor.name === "Spacer" ? "lines" : "paddingY";
		const current = component[property];
		if (typeof current === "number") {
			let original = originalSpacing.get(component);
			if (original === undefined) {
				original = current;
				originalSpacing.set(component, original);
			}
			const spacing = compact ? 0 : original;
			if (current !== spacing) {
				component[property] = spacing;
				component.invalidate();
			}
		}

		// Containers expose children; mouse regions wrap a single child.
		for (const child of component.children ?? []) setTreeSpacing(child, compact);
		if (component.child) setTreeSpacing(component.child, compact);
	}

	function setMessageSpacing(compact: boolean) {
		for (const component of chat.children) {
			switch (component.constructor.name) {
				case "Spacer":
				case "UserMessageComponent":
				case "AssistantMessageComponent":
				case "ToolExecutionComponent":
					setTreeSpacing(component, compact);
			}
		}
	}

	// Scan before rendering so new messages and streaming rebuilds use the current terminal height.
	chat.render = function (width) {
		setMessageSpacing(terminal.rows < COMPACT_BELOW_ROWS);
		return originalRender.call(this, width);
	};
	return () => {
		chat.render = originalRender;
		setMessageSpacing(false);
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
		if (container) restore = compactEditor(container);
		if (!restore) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.notify("pi-compact: unsupported Pi layout; above-editor container or spacer not found", "warning");
			return;
		}

		// Pi mounts the transcript document first: header, resource listing, then chat messages.
		const document = tui.children[0] as Container;
		const chat = document.children?.[2] as Container | undefined;
		if (chat?.children) {
			const restoreEditor = restore;
			const restoreMessages = compactTranscript(chat, tui.terminal);
			restore = () => {
				restoreMessages();
				restoreEditor();
			};
		} else {
			ctx.ui.notify("pi-compact: unsupported Pi transcript layout; message spacing unchanged", "warning");
		}

		// setWidget already schedules a redraw, including when removing the anchor.
		cleanup = () => ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.on("session_shutdown", () => {
		cleanup?.();
		cleanup = undefined;
	});
}
