import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "off" | "fast" | "ultrafast";
type Sample = { provider: string; model: string; tier?: string; tokens: number; durationMs: number };
type Total = { tokens: number; durationMs: number; requests: number };
const tpsEntryType = "openai-speed-tps";
const icons: Record<Mode, string> = { off: "󰾆", fast: "", ultrafast: "" };
const colors = { off: "dim", fast: "accent", ultrafast: "warning" } as const;
// Priority is OpenAI's accepted alias for Fast mode.
const serviceTiers = { off: undefined, fast: "priority", ultrafast: "ultrafast" } as const;
const commandCompletions = [
	{ value: "on", label: "on", description: "Request Fast (priority tier)" },
	{ value: "ultrafast", label: "ultrafast", description: "Request Ultrafast" },
	{ value: "off", label: "off", description: "Stop overriding the service tier" },
	{ value: "status", label: "status", description: "Show the selected speed mode" },
	{ value: "tps", label: "tps", description: "Toggle request TPS in the speed widget" },
	{ value: "debug on", label: "debug on", description: "Show requested and returned tiers in the terminal" },
	{ value: "debug off", label: "debug off", description: "Hide tier diagnostics" },
];

export default function (pi: ExtensionAPI) {
	let mode: Mode = "off";
	let debug = false;
	let requestedTier = "unset";
	let showTps = true;
	let latest: Sample | undefined;
	let pending: { start: number; tier?: string } | undefined;
	const totals = new Map<string, Total>();

	function addSample(sample: Sample): void {
		latest = sample;
		const key = `${sample.provider}/${sample.model}${sample.tier ? ` [${sample.tier}]` : ""}`;
		const total = totals.get(key) ?? { tokens: 0, durationMs: 0, requests: 0 };
		total.tokens += sample.tokens;
		total.durationMs += sample.durationMs;
		total.requests++;
		totals.set(key, total);
	}

	function rate(sample: Pick<Sample, "tokens" | "durationMs">): string {
		return (sample.tokens / (sample.durationMs / 1000)).toFixed(1);
	}

	function isOpenAI(provider: string | undefined): boolean {
		return provider === "openai" || provider === "openai-codex";
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const openai = isOpenAI(ctx.model?.provider);
		const displayMode = openai ? mode : "off";
		let text = ctx.ui.theme.fg(colors[displayMode], icons[displayMode]);
		if (showTps && openai) text += ctx.ui.theme.fg("muted", ` TPS ${latest ? rate(latest) : "-"}`);
		ctx.ui.setStatus("openai-speed", text);
	}

	pi.on("session_start", (_event, ctx) => {
		// Reload resets the mode, so an old connection must not retain its previous tier hint.
		cleanupSessionResources(ctx.sessionManager.getSessionId());
		mode = "off";
		debug = false;
		requestedTier = "unset";
		showTps = true;
		latest = undefined;
		pending = undefined;
		totals.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === tpsEntryType) addSample(entry.data as Sample);
		}
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.registerCommand("openai-speed", {
		description: "Show or set OpenAI speed: /openai-speed [on|off|ultrafast|status|tps|debug on|debug off]",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trimStart().toLowerCase();
			const matches = commandCompletions.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "tps") {
				showTps = !showTps;
				updateStatus(ctx);
				ctx.ui.notify(`OpenAI speed TPS: ${showTps ? "on" : "off"}.`, "info");
				return;
			}
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
					ctx.ui.notify("Usage: /openai-speed [on|off|ultrafast|status|tps|debug on|debug off]", "error");
					return;
			}
			if (nextMode !== mode) {
				if (!ctx.isIdle()) {
					ctx.ui.notify(`OpenAI speed: ${nextMode} requested; waiting for Pi to become idle.`, "info");
				}
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
		// message_start occurs after the provider responds, so time from this hook instead.
		pending = { start: performance.now() };
		const payload = event.payload as { service_tier?: string };
		const tier = serviceTiers[mode];
		requestedTier = tier ?? payload.service_tier ?? "unset";
		if (tier) return { ...payload, service_tier: tier };
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const request = pending;
		pending = undefined;
		if (!request || message.stopReason === "error" || message.stopReason === "aborted") return;
		const sample: Sample = {
			provider: message.provider,
			model: message.model,
			tier: request.tier,
			// Output usage includes reasoning tokens.
			tokens: message.usage.output,
			durationMs: performance.now() - request.start,
		};
		addSample(sample);
		pi.appendEntry(tpsEntryType, sample);
		updateStatus(ctx);
	});

	pi.registerCommand("tps", {
		description: "Show session TPS by model and speed tier",
		handler: async (_args, ctx) => {
			const lines = [...totals].map(([key, total]) =>
				`${key}: ${rate(total)} TPS · ${total.requests} requests · ${total.tokens} tokens`,
			);
			ctx.ui.notify(lines.join("\n") || "No completed requests yet.", "info");
		},
	});

	pi.on("provider_stream_event", (event, ctx) => {
		if (!isOpenAI(event.provider)) return;
		const data = event.data as { type: string; response?: { service_tier?: string } };
		if (pending && data.response?.service_tier) pending.tier = data.response.service_tier;
		if (!debug) return;
		// Codex exposes response.done before Pi normalizes it to response.completed.
		switch (data.type) {
			case "response.completed":
			case "response.done":
			case "response.incomplete":
				ctx.ui.notify(`OpenAI speed: requested=${requestedTier} returned=${data.response?.service_tier ?? "unknown"}`, "info");
		}
	});
}
