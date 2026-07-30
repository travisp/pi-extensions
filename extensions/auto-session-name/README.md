# pi-auto-session-name

Tiny Pi extension that names a new unnamed session from its first user message.

It uses Pi's OpenAI Codex subscription provider directly:

```text
openai-codex/gpt-5.4-mini
```

## Run locally

```bash
pi -e .
```

## Install locally

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD/index.ts" ~/.pi/agent/extensions/auto-session-name.ts
```

Then run `/reload` inside Pi.
