# OpenAI Speed

- `/fast` or `/fast status`: show the current mode.
- `/fast on`: Fast (`service_tier: "priority"`).
- `/fast ultrafast`: Ultrafast (`service_tier: "ultrafast"`).
- `/fast off`: stop overriding the service tier.

Starts off every session and reload. No configuration or persistence.
Applies to any model on `openai` or `openai-codex`; the server decides tier availability.

Publishes status key `openai-speed`: 󰾆 off,  Fast,  Ultrafast.
Other providers show the off icon without changing the selected mode.

Disable the original `@benvargas/pi-openai-fast` extension to avoid a conflicting `/fast` command.
