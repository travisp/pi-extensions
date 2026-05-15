# pi-remote-ssh-admin

An _experimental_ Pi extension for running Pi's normal `read`, `write`, `edit`, and `bash` tools on a remote host over SSH while Pi itself keeps running locally, and also allowing Pi to continue running local tools as well.

Pi config, skills, API keys, model providers, and `local_*` tools remain local. The remote server does **not** need Pi installed.

Note: there are inherent risks of this extension and it should never been used with anything sensitive. Use at your own risk.

## Usage

```bash
pi --ssh debian@1.2.3.4
pi --ssh debian@1.2.3.4:/srv/app
```

The extension is inactive unless `--ssh` is passed.

## Remote requirements

- SSH key-based auth from the local Pi machine (does not currently prompt for initial login)
- a remote login shell that accepts standard shell commands
- standard Debian-like tools: `mv`, `mkdir`, `rm`, `mktemp`, GNU `base64`, and `stat`

No `tmux`, Python, Node, Perl, or Pi installation is required on the remote host.

## How it works

`pi-remote-ssh-admin` starts one persistent non-PTY SSH process per remote target:

```text
ssh -T user@host
```

Each command is queued and wrapped with a random high-entropy sentinel line. The transport reads output until the exact sentinel line for that command appears. Timeouts kill the SSH process; the next command starts a fresh transport.

File reads and writes use base64 through the shell stream, so binary files are not sent as raw terminal data. The maximum file size is 25 MiB.

## Differences from the [ssh extension example in the pi respository](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/ssh.ts).
- Adds `local_` versions of tools so that the agent can also perform actions locally (especially local skills etc.)
- Adds a mechanism for granted elevated access via sudo password on the remote server to the agent.
- Utilizes a persistent SSH connection (two if sudo is being used).

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

Approval-based elevation is available when needed. Approve it with either:

```text
/remote-admin-elevate
```

or the `remote_admin_elevate` tool when the agent needs privileged access.

When approval is requested, choose one of:

- just for this agent response, when requested by the agent
- just for the next agent response, when requested with `/remote-admin-elevate`
- persistent until revoked
- no

After approval, the extension starts a second SSH transport running a root shell via sudo. It first tries the actual root shell startup non-interactively. If sudo requires a password, Pi prompts locally in a masked popup and retries with a fresh sudo prompt. The normal SSH transport is not turned into root.

"Security" properties:

- the sudo password is prompted locally only when sudo reports that one is required
- the password is only sent after the expected random sudo prompt appears
- the password is never passed in command-line args or environment variables
- the password is never intentionally written to disk
- the password is never intentionally shown to the model or logged
- the password is not intentionally retained after the elevated shell starts
- response-scoped elevation is killed when the agent finishes responding to the current user request
- persistent elevation is killed when revoked or when the session shuts down

While the elevated session is active, the default remote tools use the root transport. Revoke with:

```text
/remote-admin-revoke
```

## Flags

```text
--ssh <user@host[:remote-cwd]>
    SSH remote. Include :/path to set the remote working directory.
    Without a path, defaults to the remote shell's current directory.

--ssh-arg <arg>
    Extra SSH arg(s). Quote as needed for your shell.
```

## Optional pi-powerline-footer setup

`pi-remote-ssh-admin` publishes its connection status with Pi's normal status API under the key `remote-admin`.
If you use `pi-powerline-footer`, you can promote that status into a dedicated Powerline item.

Add this to project-local `.pi/settings.json` or global `~/.pi/agent/settings.json`:

```json
{
  "powerline": {
    "customItems": [
      {
        "id": "remote-admin",
        "statusKey": "remote-admin",
        "position": "left",
        "prefix": "🌐 SSH",
        "color": "success"
      }
    ]
  }
}
```

Then run `/reload` or restart Pi.

The item shows the remote target and remote working directory, for example:

```text
🌐 SSH · host.example.com:/remote/path
```

If you already have a `powerline` object, keep your existing fields and add the `customItems` entry. Powerline currently requires this user configuration; `setStatus` can publish the status value, but it cannot set Powerline-specific layout fields such as `position`, `prefix`, or `color`.

## Development

```bash
npm run smoke:fake-ssh
```

Runs a very poor local smoke test with a fake `ssh` executable and verifies that bash/read/write/edit share one persistent transport.
