# pi-remote-ssh-admin

Pi extension for running Pi's normal `read`, `write`, `edit`, and `bash` tools on a remote host over SSH while Pi itself keeps running locally.

Pi config, skills, API keys, model providers, and `local_*` tools remain local. The remote server does **not** need Pi installed.

## Usage

```bash
pi -e /path/to/pi-remote-ssh-admin --ssh debian@1.2.3.4
pi -e /path/to/pi-remote-ssh-admin --ssh debian@1.2.3.4:/srv/app
```

The extension is inactive unless `--ssh` is passed.

## Remote requirements

- SSH key-based auth from the local Pi machine
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

After approval, the extension starts a second SSH transport running a root shell via sudo. It does **not** turn the normal SSH transport into root.

Security properties:

- the sudo password is prompted locally in a masked Pi popup
- the password is never passed in command-line args or environment variables
- the password is never written to disk
- the password is never shown to the model or logged
- if sudo is NOPASSWD, no password line is sent to the root shell
- the password is discarded after the elevated shell starts
- response-scoped elevation is killed when the agent finishes responding to the current user request
- persistent elevation is killed when revoked or when the session shuts down

While the elevated session is active, the default remote tools use the root transport. Revoke with:

```text
/remote-admin-revoke
```

If an operation fails with permission denied while elevation is inactive, the tool error tells the agent/user to request elevation and retry.

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
    "preset": "minimal",
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

Runs a local smoke test with a fake `ssh` executable and verifies that bash/read/write/edit share one persistent transport.

The smoke test resolves Pi from local `node_modules` by default. In VM/container environments such as Gondolin, install dependencies there or point the test at a mounted/built Pi package:

```bash
PI_CODING_AGENT_ROOT=/path/to/@earendil-works/pi-coding-agent npm run smoke:fake-ssh
```

