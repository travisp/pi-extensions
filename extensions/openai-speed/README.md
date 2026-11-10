# OpenAI Speed

Argument autocomplete offers all options with descriptions, including `debug on` and `debug off`. Type a prefix (e.g. `/openai-speed u` or `/openai-speed debug of`) to narrow the suggestions.

- `/openai-speed` or `/openai-speed status`: show the current mode.
- `/openai-speed on`: Fast (`service_tier: "priority"`).
- `/openai-speed ultrafast`: Ultrafast (`service_tier: "ultrafast"`).
- `/openai-speed off`: stop overriding the service tier.
- `/openai-speed tps`: toggle request TPS next to the speed icon (starts enabled).
- `/tps`: show session TPS averages and totals by model and reported speed tier.
- `/openai-speed debug on|off`: enable or disable terminal notifications after each completed/incomplete OpenAI response, e.g. `OpenAI speed: requested=ultrafast returned=priority`.

Debug reports the outgoing tier seen by this extension and the server's returned `service_tier`. An omitted outgoing tier shows `unset`; an omitted response tier shows `unknown`, not confirmation. Other extensions running afterward can still change the outgoing tier. No payloads or diagnostics are persisted.

## ChatGPT OAuth and Fast mode

In current Pi versions, `openai` supports API keys and direct ChatGPT-plan OAuth. Direct OAuth uses the [public Responses API](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), separate from the `openai-codex` backend.

Fast requests use `priority`, which OpenAI documents as [equivalent to `fast` for supported models](https://developers.openai.com/api/docs/guides/fast-mode). No change of spelling is needed for OAuth.

Pi allows this payload override, but that does not guarantee Fast or Ultrafast availability for direct ChatGPT-plan OAuth. OpenAI lists an unsupported service-tier override as a possible cause of [`subscription_sharing_unsupported_capability`](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery). If the server rejects this extension's tier override, select `/openai-speed off` before retrying. The selected mode does not confirm the tier used or its billing; do not assume Codex subscription multipliers apply to direct OAuth.

## Routing and connections

For `openai-codex`, sends `x-codex-routing-hint: model=<model>;tier=<tier>` on SSE requests and new WebSocket handshakes. When off, sends only `model=<model>`. The `openai` provider does not receive this header, whether authenticated with an API key or ChatGPT OAuth.

Debug shows the outgoing hint, not server confirmation. Codex may return `service_tier: "default"` even for tiered requests. No other headers are logged.

Speed changes wait until Pi is idle (the entire agent run must finish, not just one model response), then clear only this session's transport resources. While busy, the command immediately reports the requested mode and that it is waiting; the icon and tier change only when the wait finishes. The next request reconnects with the new hint; conversation history stays intact. Same-mode selections, status queries, and debug toggles keep the connection. Session start/reload also clears it when resetting to off. Transport can remain `auto` or `websocket-cached`.

## Session behavior

Speed and debug start off every session and reload; TPS display starts on. Display settings are not persisted.
Applies to any model on `openai` or `openai-codex`; the server decides tier availability.

Publishes one status key, `openai-speed`: 󰾆 off,  Fast,  Ultrafast, followed by request TPS when enabled.
Other providers show only the off icon without changing the selected mode.
The icon reflects the selected mode, not server confirmation; debug does not change it.

## TPS

The widget shows the latest completed OpenAI request: reported output tokens (including reasoning) divided by model-request time. Tools and idle time are excluded; failed and aborted requests are skipped. Hiding TPS does not stop measurement.

Measurements are saved in the session and restored from the active branch on resume and `/tree` navigation. Navigating branches preserves the selected speed mode, debug setting, and TPS visibility. `/tps` groups averages by model and reported service tier. Codex’s returned tier may not reflect the requested speed mode.

The command is separate from pi-usage’s `/fast`. Keep other Fast-mode overrides disabled when using this extension to avoid competing service-tier changes.
