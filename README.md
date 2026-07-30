# Travis Pi Extensions

Small pi extensions that I use that don't deserve their own git repository.

Each extension is kept in its own directory and can be installed individually.

Some of these are more developed than others. The extensions that have been published to npm are ready for others to use.

## Extensions

- [`prompt-ninja`](extensions/prompt-ninja/) customizes and previews Pi system-prompt sections.
- [`powerline-patch`](extensions/powerline-patch/) provides the customized powerline footer and shell mode.
- [`remote-ssh-admin`](extensions/remote-ssh-admin/) routes remote tools through persistent SSH transports with approved elevation.
- [`custom-permission-gate`](extensions/custom-permission-gate/) prompts before potentially dangerous shell commands.
- [`auto-session-name`](extensions/auto-session-name/) names new sessions automatically.
- [`slash-command-guard`](extensions/slash-command-guard/) prevents mistyped or unknown slash commands from being sent as regular user messages. If there is a close known command, it includes a “Did you mean ...?” hint; otherwise it shows an unknown-command error.
- [`system-prompt-display`](extensions/system-prompt-display/) records the initial system prompt and later changes.
- [`herdr-dev`](extensions/herdr-dev/) runs a project's development server in a dedicated Herdr tab.

## Usage

Install all extensions:

```bash
pi install /path/to/pi-extensions
```

Install one extension:

```bash
pi install /path/to/pi-extensions/extensions/slash-command-guard
pi install /path/to/pi-extensions/extensions/system-prompt-display
```

The root package loads only each extension's declared entry point, so support files and tests under `extensions/` are not treated as standalone extensions.
