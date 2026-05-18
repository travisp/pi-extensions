# Slash Command Guard

Prevents mistyped or unknown slash commands from being sent as normal user messages.

Does not interfere with custom slash commands registered by extensions. It also does not interfere with prompt slash commands, or skill slash commands.

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

## Why?

If you never start a message to the agent with a slash, you've probably had the experience of attempting a slash command, hitting enter quickly, and then realizing you just sent `/treee` to the agent, furiously aborting, and then going back up the session tree so `/treee` doesn't sit in your session context (or using `pi-wtf`). This simply prevents you from sending a bad slash command to the agent, and attempts to help tell you what you meant to type.

## Related

This pairs well with my [`pi-wtf`](https://github.com/travisp/pi-wtf). Slash Command Guard catches mistyped slash commands before they are sent; `pi-wtf` can help recover and revise prompts after they have already been submitted.

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
npm run check:builtins
```
