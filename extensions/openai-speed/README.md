# OpenAI Speed

- `/openai-speed` or `/openai-speed status`: show the current mode.
- `/openai-speed on`: Fast (`service_tier: "priority"`).
- `/openai-speed ultrafast`: Ultrafast (`service_tier: "ultrafast"`).
- `/openai-speed off`: stop overriding the service tier.

Starts off every session and reload. No configuration or persistence.
Applies to any model on `openai` or `openai-codex`; the server decides tier availability.

Publishes status key `openai-speed`: 󰾆 off,  Fast,  Ultrafast.
Other providers show the off icon without changing the selected mode.

The command is separate from pi-usage’s `/fast`. Keep other Fast-mode overrides disabled when using this extension to avoid competing service-tier changes.
