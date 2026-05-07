# pi-ssh-tmux

Pi extension for routing tool execution to a remote host through a persistent `tmux` session over SSH.

```bash
pi -e /path/to/pi-ssh-tmux --ssh-tmux user@host:/remote/workdir
pi -e /path/to/pi-ssh-tmux --ssh-tmux user@host
```

The extension overrides `read`, `write`, `edit`, `bash`, `ls`, `find`, and `grep` so operations execute inside a remote `tmux` pane named `pi-ssh-tmux`.

The tmux pane keeps shell echo disabled for reliable command framing, but prints human-readable audit lines like `[pi bash] ...`, `[pi read] ...`, and `[pi write] ...` so you can review what Pi is doing without dumping internal base64 payloads into scrollback.

## On-demand sudo

Attach to the same remote tmux session from another terminal:

```bash
ssh -tt user@host 'tmux attach -t pi-ssh-tmux'
```

Run:

```bash
sudo -v
```

Enter your password, then detach with `Ctrl-b d`. While sudo's timestamp is valid, Pi can run `sudo -n ...` inside that same tmux session. To lock it again:

```bash
sudo -k
```

No sudo password is passed through Pi or the model.
