import { createCodemodeExtension, keyHint, type CodemodeToolDetails, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

const SCRIPT_PREVIEW_ROWS = 11;
const RESULT_PREVIEW_ROWS = 16;

/** Limit screen rows after the original component has wrapped its content. */
function limitRows(component: Component, maxRows: number, footer?: string): Component {
	return {
		render(width) {
			const rows = component.render(width);
			if (rows.length <= maxRows) return rows;

			const preview = rows.slice(0, maxRows);
			preview.push(truncateToWidth(keyHint("app.tools.expand", "to expand"), width, "..."));
			if (footer) preview.push(truncateToWidth(footer, width, "..."));
			return preview;
		},
		invalidate() {
			component.invalidate();
		},
	};
}

export default function (pi: ExtensionAPI) {
	// Reuse Pi's factory so execution, settings, and persistence stay upstream-owned.
	// Only the tool's two renderers change.
	createCodemodeExtension()({
		...pi,
		registerTool(tool) {
			const renderCall = tool.renderCall!;
			const renderResult = tool.renderResult!;
			pi.registerTool({
				...tool,
				renderCall(args, theme, context) {
					// Pi would otherwise pass our wrapper to a renderer expecting its own Text component.
					const component = renderCall(args, theme, { ...context, lastComponent: undefined })!;
					return context.expanded ? component : limitRows(component, SCRIPT_PREVIEW_ROWS);
				},
				renderResult(result, options, theme, context) {
					const component = renderResult(result, options, theme, { ...context, lastComponent: undefined })!;
					if (options.expanded) return component;

					// Keep the saved output discoverable if the row cap hides the original footer.
					const path = (result.details as CodemodeToolDetails | undefined)?.fullOutputPath;
					const footer = path ? theme.fg("muted", `Full output: ${path}`) : undefined;
					return limitRows(component, RESULT_PREVIEW_ROWS, footer);
				},
			});
		},
	});
}
