import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "off" | "fast" | "ultrafast";
const icons: Record<Mode, string> = { off: "󰾆", fast: "", ultrafast: "" };
const colors = { off: "dim", fast: "accent", ultrafast: "warning" } as const;

export default function (pi: ExtensionAPI) {
	let mode: Mode = "off";

	function isOpenAI(ctx: ExtensionContext): boolean {
		const provider = ctx.model?.provider;
		return provider === "openai" || provider === "openai-codex";
	}

	function updateStatus(ctx: ExtensionContext): void {
		const displayMode = isOpenAI(ctx) ? mode : "off";
		ctx.ui.setStatus("openai-speed", ctx.ui.theme.fg(colors[displayMode], icons[displayMode]));
	}

	pi.on("session_start", (_event, ctx) => {
		mode = "off";
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.registerCommand("openai-speed", {
		description: "Show or set OpenAI speed: /openai-speed [on|off|ultrafast|status]",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			switch (command) {
				case "":
				case "status":
					break;
				case "on":
					mode = "fast";
					break;
				case "off":
				case "ultrafast":
					mode = command;
					break;
				default:
					ctx.ui.notify("Usage: /openai-speed [on|off|ultrafast|status]", "error");
					return;
			}
			updateStatus(ctx);
			ctx.ui.notify(`OpenAI speed: ${mode}.`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (mode === "off" || !isOpenAI(ctx)) return;
		return {
			...(event.payload as Record<string, unknown>),
			// Priority is OpenAI's accepted alias for Fast mode.
			service_tier: mode === "fast" ? "priority" : "ultrafast",
		};
	});
}
