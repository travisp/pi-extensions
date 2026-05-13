# pi-remote-admin

Pi extension for running Pi's normal `read`, `write`, `edit`, and `bash` tools on a remote host over SSH while Pi itself keeps running locally.

Pi config, skills, API keys, model providers, and `local_*` tools remain local. The remote server does **not** need Pi installed.

## Usage

```bash
pi -e /path/to/pi-remote-admin --host debian@1.2.3.4 --cwd /srv/app
pi -e /path/to/pi-remote-admin --host 1.2.3.4 --user debian --port 2222 --cwd /srv/app
pi -e /path/to/pi-remote-admin --host debian@1.2.3.4 --cwd /srv/app --elevation ask-session --elevation-ttl 30m
```

The extension is inactive unless `--host` is passed.

## Remote requirements

- SSH key-based auth from the local Pi machine
- `/bin/sh` by default, or the shell specified with `--shell`
- standard Debian-like tools: `cat`, `mv`, `mkdir`, `rm`, `mktemp`, `base64`, `chmod`, `chown`, and `stat`

No `tmux`, Python, Node, Perl, or Pi installation is required on the remote host.

## How it works

`pi-remote-admin` starts one persistent non-PTY SSH process per remote target:

```text
ssh -T user@host /bin/sh
```

Each command is queued and wrapped with a random high-entropy sentinel line. The transport reads output until the exact sentinel line for that command appears. Timeouts kill the SSH process; the next command starts a fresh transport.

File reads and writes use base64 through the shell stream, so binary files are not sent as raw terminal data. The default maximum file size is 25 MiB; configure with `--max-file-bytes`.

## Tool mapping

When active, these default Pi tools operate on the remote host:

- `read`
- `write`
- `edit`
- `bash`

User `!` bash commands also run remotely.

Local escape hatches are always available when the extension is active:

- `local_read`
- `local_write`
- `local_edit`
- `local_bash`

Use them for files and commands on the machine where Pi is running, such as `~/.pi/agent/skills`.

## Elevation

Approval-based elevation is enabled by default with a 30 minute TTL. Approve it with either:

```text
/remote-admin-elevate
```

or the `remote_admin_elevate` tool when the agent needs privileged access.

After approval, the extension starts a second persistent SSH transport running a root shell via sudo. It does **not** turn the normal SSH transport into root.

Security properties:

- the sudo password is prompted locally in a masked Pi popup
- the password is never passed in command-line args or environment variables
- the password is never written to disk
- the password is never shown to the model or logged
- if sudo is NOPASSWD, no password line is sent to the root shell
- the password is discarded after the elevated shell starts
- the elevated transport is killed when the TTL expires or when revoked

While the elevated session is active, the default remote tools use the root transport. Revoke with:

```text
/remote-admin-revoke
```

If an operation fails with permission denied while elevation is inactive, the tool error tells the agent/user to request elevation and retry.

## Flags

```text
--host <ssh-host>
    Remote SSH host. May include user@host.

--user <user>
    SSH user when --host does not include user@.

--port <port>
    SSH port.

--cwd <remote-cwd>
    Remote working directory. Defaults to the remote shell's current directory.

--shell </bin/sh|/bin/bash>
    Remote shell. Default: /bin/sh.

--max-file-bytes <bytes>
    Maximum file size for remote read/write. Default: 26214400.

--elevation off|ask-session
    Elevation mode. Default: ask-session.

--elevation-ttl <duration>
    Elevated session TTL. Examples: 30m, 1h. Default: 30m.

--ssh-arg <arg>
    Extra SSH arg(s). Quote as needed for your shell.

--log-elevated-ops
    Add visible summaries for elevated operations. Never logs file contents or passwords.

--no-elevation
    Force elevation off.
```

## Elevated operation logging

When `--log-elevated-ops` is set, visible summaries are added for root operations, for example:

```text
[root active 28m] bash: apt update && apt install -y nginx ufw fail2ban exit 0
[root active 27m] write: /etc/nginx/sites-available/app 1432 bytes
[root active 26m] bash: nginx -t exit 0
[root expired] expired: elevated transport closed
```

Logs never include sudo passwords or file contents.

## Development

```bash
npm run smoke:fake-ssh
```

Runs a local smoke test with a fake `ssh` executable and verifies that bash/read/write/edit share one persistent transport.

## Removed tmux behavior

`tmux` is no longer used for normal `read`/`write`/`edit`/`bash` execution. The old attach/capture/send-keys transport has been removed from the core path. An optional interactive console can be added later, but it should not be used as the backend for tools.
