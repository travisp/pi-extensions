# Travis Pi Extensions

Small pi extensions that I use that don't deserve their own git repository.

Each extension is kept in its own directory and can be installed individually.

## Extensions

- [`slash-command-guard`](extensions/slash-command-guard/) prevents mistyped or unknown slash commands from being sent as regular user messages. If there is a close known command, it includes a “Did you mean ...?” hint; otherwise it shows an unknown-command error.

## Usage

Install all extensions:

```bash
pi install /path/to/pi-extensions
```

Install one extension:

```bash
pi install /path/to/pi-extensions/extensions/slash-command-guard
```
