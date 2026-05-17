# Slash Command Guard

Prevents mistyped or unknown slash commands from being sent as normal user messages.

## What it does

When a user submits a message that starts with `/`, this extension checks whether the slash command is known to pi. If the command is unknown, the message is blocked and an error notification is shown.

If the unknown command is close to a known command, the notification includes a hint:

```text
Unknown slash command "/quti". Did you mean "/quit"?
```

If no close match is found, it shows:

```text
Unknown slash command "/whatever".
```

The extension does not rewrite or resubmit the user's input.

## Install

Local checkout:

```bash
pi install /path/to/pi-extensions/extensions/slash-command-guard
```

NPM:

```bash
pi install npm:@smallbatchcode/pi-slash-command-guard
```

## Development

```bash
npm install
npm run typecheck
```
