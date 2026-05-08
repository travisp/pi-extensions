# pi-ssh-tmux

Pi extension for routing Pi tool execution to a remote host through a persistent single-pane `tmux` session over SSH.

Note: warning, this is a lot of slop!

## Usage

```bash
pi -e /path/to/pi-ssh-tmux --ssh-tmux user@host:/remote/workdir
pi -e /path/to/pi-ssh-tmux --ssh-tmux user@host
pi -e /path/to/pi-ssh-tmux --ssh-tmux user@host --tmux-name pi-work
```

The extension is inactive unless `--ssh-tmux` is passed. With `--ssh-tmux`, it creates or reuses a remote tmux session named `pi-ssh-tmux` by default. Use `--tmux-name` to choose a different session. If no remote path is provided, it uses the remote login directory.

## Remote requirements

- SSH key-based auth
- a loaded `ssh-agent` if your key needs a passphrase
- `tmux`
- `base64`
- `file`

Tool setup and execution use non-interactive SSH with `BatchMode=yes`, `StrictHostKeyChecking=accept-new`, and a 10 second connect timeout. New host keys are accepted automatically; changed host keys, password prompts, and other interactive SSH prompts fail and are reported in Pi as an SSH tmux warning/status instead of hanging invisibly.

## What runs remotely

When `--ssh-tmux` is active, the extension overrides these Pi tools so they execute against the remote tmux session:

- `read`
- `write`
- `edit`
- `bash`

User `!` bash commands are also routed through the same remote tmux session.

When `--ssh-tmux` is active, the extension also registers explicit local escape-hatch tools that call Pi's original local implementations without replacing them:

- `local_read`
- `local_write`
- `local_edit`
- `local_bash`

Use these for local Pi infrastructure, such as scripts under `~/.pi/agent/skills`.

During normal Pi tool execution, the tmux pane keeps shell echo disabled for reliable command framing, but prints human-readable audit lines like `[pi bash] ...`, `[pi read] ...`, and `[pi write] ...` so you can review what Pi is doing without dumping internal base64 payloads into scrollback.

## Flags

```text
--ssh-tmux user@host[:/remote/path]
    Enable remote execution through SSH + tmux.

--tmux-name <session-name>
    Remote tmux session name. Default: pi-ssh-tmux.

--ssh-tmux-shell-timeout <seconds>
    Idle timeout for the remote bash shell. Default: 86400 seconds (one day).
    Use 0 to disable the shell idle timeout.
```

The shell timeout is implemented with bash `TMOUT`, so it applies when the shell is idle at a prompt, whether attached or detached. It does not kill a currently running command.

## Slash commands

These commands are only registered when `--ssh-tmux` is passed.

```text
/ssh-tmux-attach
    Suspend Pi and attach this terminal to the remote tmux session.
    Detach with Ctrl-b then plain d to return to Pi.
    When you return, Pi asks what to do with captured attach output:
    discard, add to context, or summarize then add. Discard is first/default.

/ssh-tmux-kill
    Kill the remote tmux session used by this extension.
    The next Pi tool call recreates it if --ssh-tmux is still active.
```

Attach output added to context appears immediately as a visible, expandable custom message. Summarization uses the current Pi model and API credentials; if no model or API key is available, Pi warns and adds nothing. Only attach sessions started through `/ssh-tmux-attach` are offered for capture. Output can include secrets, so choose `discard` unless you want the transcript or summary available to the model.

## On-demand sudo

Attach to the same remote tmux session from inside Pi:

```text
/ssh-tmux-attach
```

Pi suspends while you are attached. The extension enables terminal echo for the human attach session and leaves it on after you detach. The next Pi tool execution disables echo again before sending internal payloads.

For compatibility with footer/status-line extensions such as `pi-powerline-footer`, `/ssh-tmux-attach` resets terminal scroll margins, exits alternate-screen modes, and disables tmux-style mouse reporting before launching `ssh -tt ... tmux attach`, then resets them again before Pi's TUI restarts. When Pi repaints after detach, it avoids the full TUI redraw path that clears terminal scrollback, so normal mouse-wheel scrollback remains available.

While attached, run:

```bash
sudo -v
```

Enter your password, then detach with:

```text
Ctrl-b d
```

While sudo's timestamp is valid, Pi can run `sudo -n ...` inside that same tmux session. To lock sudo again, attach and run:

```bash
sudo -k
```

Do not press `Ctrl-d` unless you intentionally want to exit the shell; it can close the only pane and end the tmux session.

No sudo password is passed through Pi or the model.

## Manual tmux access

You can also attach from another terminal:

```bash
ssh -tt user@host 'tmux attach -t pi-ssh-tmux'
# or, if you started Pi with --tmux-name pi-work:
ssh -tt user@host 'tmux attach -t pi-work'
```

List or kill the session manually:

```bash
ssh user@host 'tmux ls'
ssh user@host 'tmux kill-session -t pi-ssh-tmux'
```

## Lifecycle

By default, the remote tmux session persists when Pi exits or crashes. This is intentional: it lets remote work survive local connection problems and lets you reconnect to inspect the session.

Cleanup options:

- wait for the shell idle timeout, default one day
- run `/ssh-tmux-kill` inside Pi
- manually run `tmux kill-session -t pi-ssh-tmux` on the remote (replace the name if you used `--tmux-name`)
- disable the timeout with `--ssh-tmux-shell-timeout 0` if you want indefinite persistence
