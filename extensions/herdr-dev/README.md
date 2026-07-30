# pi-herdr-dev

Run a project's development server in a dedicated [Herdr](https://herdr.dev) tab while keeping Pi aware of its status and logs.

## Install

```bash
pi install /absolute/path/to/pi-herdr-dev
```

Restart Pi or run `/reload` after installing.

## Use

```text
/dev start                 infer and start the project's dev command
/dev start <command>       start this command and remember it
/dev status                show the command, pane, and process state
/dev logs [lines]          show the last 80 lines by default (maximum 200)
/dev restart [command]     close the old pane and start again
/dev stop                  stop the server and close its pane
/dev tool on|off           enable or disable the agent tool
/dev forget                stop and remove this project's saved state
/dev help                  show command help
```

`/dev` by itself is the same as `/dev status`.

The server opens in an unfocused tab named `server`. If the command exits, `/dev start` reuses that tab so its logs remain visible.

## Command inference

The first match wins:

1. `bin/dev`
2. A `dev` script in `package.json`
3. A `start` script in `package.json`
4. `bin/rails server` for a Rails application

Node projects use the package manager declared by `packageManager`, then lockfile detection, then npm.

If inference does not fit a project, run `/dev start <command>` once. That command is remembered for the project.

## Agent awareness

Server management and agent access are separate:

```text
/dev tool on     enable and remember the dev_server tool for this project
/dev tool off    disable it without stopping the server
```

When enabled, Pi can inspect status and logs without copying the live log stream into every prompt. It can also start or restart the server when required to test its work.

Run `/dev forget` to stop the server, remove the project's global saved state, and disable the tool. Because Pi does not expose tool unregistration, an inactive definition remains internal until `/reload`; it is removed from the agent's active tools immediately.

## State

No files are written to project directories. Pane IDs and remembered commands are stored in:

```text
~/.pi/agent/pi-herdr-dev.json
```

`PI_CODING_AGENT_DIR` is respected when set. Stopping a server keeps its remembered command for the next start; forgetting it removes the project entry entirely.

## Requirements

- Pi
- Herdr
- Pi must be running in a Herdr-managed pane to start a server

## Development

```bash
npm install
npm run check
pi -e .                 # test without installing
pi install "$PWD"       # install this live checkout once
```

After editing an installed checkout, run `/reload` in Pi.

## License

MIT
