import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "off" | "fast" | "ultrafast";
const icons: Record<Mode, string> = { off: "󰾆", fast: "", ultrafast: "" };
const colors = { off: "dim", fast: "accent", ultrafast: "warning" } as const;
// Priority is OpenAI's accepted alias for Fast mode.
const serviceTiers = { off: undefined, fast: "priority", ultrafast: "ultrafast" } as const;
const commandCompletions = [
	{ value: "on", label: "on", description: "Request Fast (priority tier)" },
	{ value: "ultrafast", label: "ultrafast", description: "Request Ultrafast" },
	{ value: "off", label: "off", description: "Stop overriding the service tier" },
	{ value: "status", label: "status", description: "Show the selected speed mode" },
	{ value: "debug on", label: "debug on", description: "Show requested and returned tiers in the terminal" },
	{ value: "debug off", label: "debug off", description: "Hide tier diagnostics" },
];

export default function (pi: ExtensionAPI) {
	let mode: Mode = "off";
	let debug = false;
	let requestedTier = "unset";

	function isOpenAI(provider: string | undefined): boolean {
		return provider === "openai" || provider === "openai-codex";
	}

	function updateStatus(ctx: ExtensionContext): void {
		const displayMode = isOpenAI(ctx.model?.provider) ? mode : "off";
		ctx.ui.setStatus("openai-speed", ctx.ui.theme.fg(colors[displayMode], icons[displayMode]));
	}

	pi.on("session_start", (_event, ctx) => {
		// Reload resets the mode, so an old connection must not retain its previous tier hint.
		cleanupSessionResources(ctx.sessionManager.getSessionId());
		mode = "off";
		debug = false;
		requestedTier = "unset";
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.registerCommand("openai-speed", {
		description: "Show or set OpenAI speed: /openai-speed [on|off|ultrafast|status|debug on|debug off]",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trimStart().toLowerCase();
			const matches = commandCompletions.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "debug on" || command === "debug off") {
				debug = command === "debug on";
				ctx.ui.notify(`OpenAI speed debug: ${debug ? "on" : "off"}.`, "info");
				return;
			}
			let nextMode = mode;
			switch (command) {
				case "":
				case "status":
					break;
				case "on":
					nextMode = "fast";
					break;
				case "off":
				case "ultrafast":
					nextMode = command;
					break;
				default:
					ctx.ui.notify("Usage: /openai-speed [on|off|ultrafast|status|debug on|debug off]", "error");
					return;
			}
			if (nextMode !== mode) {
				await ctx.waitForIdle();
				// Only this session reconnects; its conversation history is unchanged.
				cleanupSessionResources(ctx.sessionManager.getSessionId());
				mode = nextMode;
			}
			updateStatus(ctx);
			ctx.ui.notify(`OpenAI speed: ${mode}.`, "info");
		},
	});

	pi.on("before_provider_headers", (event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== "openai-codex") return;
		// Pi assembles headers before the payload hook, so derive both from the selected mode.
		const tier = serviceTiers[mode];
		let hint = `model=${model.id}`;
		if (tier) hint += `;tier=${tier}`;
		event.headers["x-codex-routing-hint"] = hint;
		if (debug) ctx.ui.notify(`OpenAI speed: outgoing x-codex-routing-hint=${JSON.stringify(hint)}`, "info");
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isOpenAI(ctx.model?.provider)) return;
		const payload = event.payload as { service_tier?: string };
		const tier = serviceTiers[mode];
		requestedTier = tier ?? payload.service_tier ?? "unset";
		if (tier) return { ...payload, service_tier: tier };
	});

	pi.on("provider_stream_event", (event, ctx) => {
		if (!debug || !isOpenAI(event.provider)) return;
		const data = event.data as { type: string; response: { service_tier?: string } };
		// Codex exposes response.done before Pi normalizes it to response.completed.
		switch (data.type) {
			case "response.completed":
			case "response.done":
			case "response.incomplete":
				ctx.ui.notify(`OpenAI speed: requested=${requestedTier} returned=${data.response.service_tier ?? "unknown"}`, "info");
		}
	});
}
