import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { estimateTokens, getAgentDir, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { installRenderPatch } from "./render-patch.mjs";

export default function (pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), "extensions", "tool-context-usage.json");
	let enabled = true;
	if (existsSync(configPath)) {
		const settings = JSON.parse(readFileSync(configPath, "utf8")) as { enabled: boolean };
		enabled = settings.enabled;
	}

	let uninstall: (() => void) | undefined;
	const removePatch = () => {
		uninstall?.();
		uninstall = undefined;
	};

	const applySetting = (ctx: ExtensionContext) => {
		removePatch();
		if (!enabled || ctx.mode !== "tui") return;
		uninstall = installRenderPatch(ToolExecutionComponent.prototype, {
			estimateResult: (content) => estimateTokens({ role: "toolResult", content } as Parameters<typeof estimateTokens>[0]),
			format: (text, width, row) => {
				// Pad before coloring so the background continues to the box's right edge.
				const padded = truncateToWidth(text, width, "…").padEnd(width);
				const styled = ctx.ui.theme.fg("muted", padded);
				return row.toolDefinition?.renderShell === "self" ? styled :
					ctx.ui.theme.bg(row.result.isError ? "toolErrorBg" : "toolSuccessBg", styled);
			},
		});
	};

	pi.on("session_start", (_event, ctx) => applySetting(ctx));
	pi.on("session_shutdown", removePatch);

	pi.registerCommand("tool-context-usage", {
		description: "Show context-usage setting, or persistently enable/disable it with on|off",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action !== "" && action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /tool-context-usage [on|off]", "warning");
				return;
			}
			if (action !== "") {
				const settings = { enabled: action === "on" };
				mkdirSync(dirname(configPath), { recursive: true });
				writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`);
				enabled = settings.enabled;
				applySetting(ctx);
			}
			// Notifications request a UI redraw, including the existing tool boxes.
			ctx.ui.notify(`Tool context usage is ${enabled ? "on" : "off"}.`, "info");
		},
	});
}
