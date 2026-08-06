# Travis Pi Extensions

Small pi extensions that I use that don't deserve their own git repository.

Each extension is kept in its own directory with its own `package.json` and can be installed individually.

Some of these are more developed than others. Extensions published to the npm registry are marked **npm** below and are ready for others to use. Otherwise they are all work in progress experiments.

## Extensions

- [`prompt-ninja`](extensions/prompt-ninja/) customizes and previews Pi system-prompt sections.
- [`remote-ssh-admin`](extensions/remote-ssh-admin/) routes remote tools through persistent SSH transports with approved elevation.
- [`auto-session-name`](extensions/auto-session-name/) names new sessions automatically.
- [`slash-command-guard`](extensions/slash-command-guard/) (**npm:** [`@smallbatchcode/pi-slash-command-guard`](https://www.npmjs.com/package/@smallbatchcode/pi-slash-command-guard)) prevents mistyped or unknown slash commands from being sent as regular user messages. If there is a close known command, it includes a “Did you mean ...?” hint; otherwise it shows an unknown-command error.
- [`system-prompt-display`](extensions/system-prompt-display/) records the initial system prompt and later changes.
- [`herdr-dev`](extensions/herdr-dev/) runs a project's development server in a dedicated Herdr tab.
- [`stream-output`](extensions/stream-output/) streams progress from explicitly configured Pi print-mode runs; it is intentionally not loaded by the root package.

## Usage

Install all extensions:

```bash
pi install /path/to/pi-extensions
```

Install one extension from a local checkout:

```bash
pi install /path/to/pi-extensions/extensions/slash-command-guard
pi install /path/to/pi-extensions/extensions/system-prompt-display
```

Install a published extension from npm:

```bash
pi install npm:@smallbatchcode/pi-slash-command-guard@0.1.3
```

The root package loads only each extension's declared entry point, so support files and tests under `extensions/` are not treated as standalone extensions.
