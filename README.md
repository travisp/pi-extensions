# pi-custom-permission-gate

Pi extension that prompts for confirmation before running potentially dangerous bash commands.

Currently checks for:

- `rm -r`, `rm -rf`, `rm --recursive`
- `chmod`/`chown` commands involving `777`

## Install

From this directory:

```sh
pi install .
```

Or package it first:

```sh
npm pack
pi install ./pi-custom-permission-gate-0.1.0.tgz
```

## Development

```sh
npm install
npm run typecheck
npm run pack:dry-run
```
