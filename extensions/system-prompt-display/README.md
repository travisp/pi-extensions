# System Prompt Display

Records Pi's effective system prompt when it first appears and whenever it changes.

## What it does

On every `before_provider_request` event, this extension reads `ctx.getSystemPrompt()`. It appends a `custom` session entry only when the prompt differs from the last recorded prompt.

The first recorded entry uses the custom type `initial-system-prompt`. Later entries are only added when the prompt changes and use the custom type `system-prompt-changed`.

Snapshots are stored as `custom` session entries, which Pi excludes from LLM context.

Yes this data is already there and browseable, but this just adds a quick way to look back when in your session tree and see what was sent.:wq


## Install

Local checkout:

```bash
pi install /path/to/pi-extensions/extensions/system-prompt-display
```

NPM:

```bash
pi install npm:@smallbatchcode/pi-system-prompt-display
```

## Development

```bash
npm install
npm run typecheck
```
