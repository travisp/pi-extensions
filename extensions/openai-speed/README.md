# OpenAI Speed

Argument autocomplete offers all options with descriptions, including `debug on` and `debug off`. Type a prefix (e.g. `/openai-speed u` or `/openai-speed debug of`) to narrow the suggestions.

- `/openai-speed` or `/openai-speed status`: show the current mode.
- `/openai-speed on`: Fast (`service_tier: "priority"`).
- `/openai-speed ultrafast`: Ultrafast (`service_tier: "ultrafast"`).
- `/openai-speed off`: stop overriding the service tier.
- `/openai-speed debug on|off`: enable or disable terminal notifications after each completed/incomplete OpenAI response, e.g. `OpenAI speed: requested=ultrafast returned=priority`.

Debug reports the outgoing tier seen by this extension and the server's returned `service_tier`. An omitted outgoing tier shows `unset`; an omitted response tier shows `unknown`, not confirmation. Other extensions running afterward can still change the outgoing tier. No payloads or diagnostics are persisted.

Speed and debug both start off every session and reload. No configuration or persistence.
Applies to any model on `openai` or `openai-codex`; the server decides tier availability.

Publishes status key `openai-speed`: 󰾆 off,  Fast,  Ultrafast.
Other providers show the off icon without changing the selected mode.
The icon reflects the selected mode, not server confirmation; debug does not change it.

The command is separate from pi-usage’s `/fast`. Keep other Fast-mode overrides disabled when using this extension to avoid competing service-tier changes.
