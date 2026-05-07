# pi-ssh-tmux

Pi extension for routing tool execution to a remote host through a persistent `tmux` session over SSH.

```bash
pi -e /path/to/pi-ssh-tmux --ssh-tmux user@host:/remote/workdir
pi -e /path/to/pi-ssh-tmux --ssh-tmux user@host
```

The extension overrides `read`, `write`, `edit`, `bash`, `ls`, `find`, and `grep` so operations execute inside a remote `tmux` pane named `pi-ssh-tmux`.

During normal Pi tool execution, the tmux pane keeps shell echo disabled for reliable command framing, but prints human-readable audit lines like `[pi bash] ...`, `[pi read] ...`, and `[pi write] ...` so you can review what Pi is doing without dumping internal base64 payloads into scrollback.

By default, the remote bash shell sets `TMOUT=86400`, so an idle tmux shell exits after about one day. Override with `--ssh-tmux-shell-timeout <seconds>` or use `--ssh-tmux-shell-timeout 0` to disable the shell idle timeout.

## On-demand sudo

Attach to the same remote tmux session from inside Pi:

```text
/ssh-tmux-attach
```

Pi suspends while you are attached. The extension enables terminal echo for the human attach session and leaves it on after you detach. The next Pi tool execution disables echo again before sending internal payloads. Detach with `Ctrl-b` then plain `d` to return to Pi. Do not press `Ctrl-d`; that can close the shell and kill the tmux session.

Or attach from another terminal:

```bash
ssh -tt user@host 'tmux attach -t pi-ssh-tmux'
```

Run:

```bash
sudo -v
```

Enter your password, then detach with `Ctrl-b` then plain `d`. While sudo's timestamp is valid, Pi can run `sudo -n ...` inside that same tmux session. To lock it again:

```bash
sudo -k
```

No sudo password is passed through Pi or the model.
