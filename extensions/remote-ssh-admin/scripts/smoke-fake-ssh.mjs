#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverAndLoadExtensions, ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';

const tmp = mkdtempSync(join(tmpdir(), 'pi-remote-ssh-admin-smoke-'));
const remoteCwd = join(tmp, 'remote');
const countFile = join(tmp, 'ssh-count');
const moshiEventsFile = join(tmp, 'moshi-events');

writeFileSync(join(tmp, 'ssh'), `#!/usr/bin/env bash
count_file=\${PI_FAKE_SSH_COUNT:-}
if [[ -n "$count_file" ]]; then
  n=0
  [[ -f "$count_file" ]] && n=$(cat "$count_file")
  echo $((n + 1)) > "$count_file"
fi
batch_mode=yes
while [[ $# -gt 0 ]]; do
  case "$1" in
    -T|-tt) shift ;;
    -o)
      [[ "$2" == "BatchMode=no" ]] && batch_mode=no
      [[ "$2" == "BatchMode=yes" ]] && batch_mode=yes
      shift 2
      ;;
    -p) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
remote="$1"; shift
cmd="$*"
if [[ "\${PI_FAKE_SSH_REQUIRE_PASSWORD:-}" == "1" ]]; then
  if [[ "$batch_mode" == "yes" ]]; then
    echo "Permission denied (publickey,password)." >&2
    exit 255
  fi
  if [[ -z "\${SSH_ASKPASS:-}" ]]; then
    echo "missing SSH_ASKPASS" >&2
    exit 255
  fi
  password=$("$SSH_ASKPASS" "$remote's password:") || exit 255
  if [[ "$password" != "\${PI_FAKE_SSH_PASSWORD:-opensesame}" ]]; then
    echo "Permission denied, please try again." >&2
    exit 255
  fi
fi
if [[ -n "$cmd" ]]; then
  exec bash -c "$cmd"
else
  exec bash
fi
`);
chmodSync(join(tmp, 'ssh'), 0o755);

writeFileSync(join(tmp, 'sudo'), `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|-S) shift ;;
    -p) shift 2 ;;
    *) break ;;
  esac
done
exec "$@"
`);
chmodSync(join(tmp, 'sudo'), 0o755);

writeFileSync(join(tmp, 'id'), `#!/usr/bin/env bash
if [[ "$1" == "-u" ]]; then
  echo 0
else
  /usr/bin/id "$@"
fi
`);
chmodSync(join(tmp, 'id'), 0o755);

writeFileSync(join(tmp, 'moshi-hook'), `#!/usr/bin/env bash
payload=$(cat)
case "$payload" in
  *PermissionRequest*) printf '%s' "$payload" > "\${PI_FAKE_MOSHI_EVENTS}.request" ;;
  *PermissionResolved*) printf '%s' "$payload" > "\${PI_FAKE_MOSHI_EVENTS}.resolved" ;;
esac
`);
chmodSync(join(tmp, 'moshi-hook'), 0o755);

writeFileSync(join(tmp, 'stat'), `#!/usr/bin/env bash
echo "fake stat should not be required by remote-admin file operations" >&2
exit 64
`);
chmodSync(join(tmp, 'stat'), 0o755);

writeFileSync(join(tmp, 'base64'), `#!/usr/bin/env bash
if [[ "$1" == "-w" ]]; then
  echo "fake BSD base64: unsupported option -w" >&2
  exit 64
fi
exec /usr/bin/base64 "$@"
`);
chmodSync(join(tmp, 'base64'), 0o755);

process.env.PATH = `${tmp}:${process.env.PATH}`;
process.env.PI_FAKE_SSH_COUNT = countFile;
process.env.PI_FAKE_SSH_REQUIRE_PASSWORD = '1';
process.env.PI_FAKE_SSH_PASSWORD = 'opensesame';
process.env.PI_FAKE_MOSHI_EVENTS = moshiEventsFile;
process.env.MOSHI_HOOK_BINARY = join(tmp, 'moshi-hook');

function makeUi(password) {
  const keybindings = {
    matches: (data, action) => {
      if (action === 'tui.input.submit') return data === '\x1b[13u';
      if (action === 'tui.select.cancel') return data === '\x1b[27u';
      if (action === 'tui.editor.deleteCharBackward') return data === '\x1b[127u';
      return false;
    },
  };
  return {
    select: async (_title, choices) => choices[0],
    confirm: async () => true,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async (factory) => {
      let result;
      const component = factory({ requestRender: () => {} }, {}, keybindings, (value) => { result = value; });
      for (const char of password) component.handleInput(`\x1b[${char.codePointAt(0)}u`);
      for (const line of component.render(16)) {
        if (visibleWidth(line) > 16) throw new Error('custom UI line exceeds 16 columns');
      }
      component.handleInput('\x1b[13u');
      return result;
    },
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() { return { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s }; },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

try {
  const result = await discoverAndLoadExtensions([resolve('extensions/remote-admin.ts')], tmp, join(tmp, 'agent'));
  assert.deepEqual(result.errors, []);
  result.runtime.flagValues.set('ssh', `fake:${remoteCwd}`);
  result.runtime.flagValues.set('use-password', true);
  const ext = result.extensions.find((e) => e.path.includes('remote-admin'));
  const sessionManager = { getSessionId: () => 'smoke-session', getSessionFile: () => undefined };
  const runner = new ExtensionRunner([ext], result.runtime, process.cwd(), sessionManager, { getApiKeyAndHeaders: async () => ({ ok: false }) });
  const ui = makeUi('opensesame');
  const ctx = { ui, hasUI: true, cwd: process.cwd(), sessionManager, model: undefined };

  runner.bindCore(
    {
      sendMessage: () => {}, sendUserMessage: () => {}, appendEntry: () => {},
      setSessionName: () => {}, getSessionName: () => undefined, setLabel: () => {},
      getActiveTools: () => ['read', 'bash', 'edit', 'write'], getAllTools: () => [],
      setActiveTools: () => {}, refreshTools: () => {}, getCommands: () => [],
      setModel: async () => true, getThinkingLevel: () => undefined, setThinkingLevel: () => {},
    },
    {
      getModel: () => undefined, isIdle: () => true, getSignal: () => undefined,
      abort: () => {}, hasPendingMessages: () => false, shutdown: () => {},
      getContextUsage: () => undefined, compact: () => {}, getSystemPrompt: () => '',
    },
    {},
  );
  runner.setUIContext(ui);
  runner.onError((error) => { throw error; });

  await runner.emit({ type: 'session_start', reason: 'startup' });

  const bash = runner.getToolDefinition('bash');
  const bashResult = await bash.execute('bash', { command: 'printf "one\\ntwo\\n"', timeout: 5 }, undefined, () => {}, ctx);
  if (bashResult.content[0].text !== 'one\ntwo\n') throw new Error('bash output mismatch');

  const write = runner.getToolDefinition('write');
  await write.execute('write', { path: 'round.txt', content: 'hello\nworld\n' }, undefined, undefined, ctx);

  const read = runner.getToolDefinition('read');
  const readResult = await read.execute('read', { path: 'round.txt' }, undefined, undefined, ctx);
  if (readResult.content[0].text !== 'hello\nworld\n') throw new Error(`read output mismatch: ${JSON.stringify(readResult.content)}`);

  const edit = runner.getToolDefinition('edit');
  await edit.execute('edit', { path: 'round.txt', edits: [{ oldText: 'world', newText: 'remote' }] }, undefined, undefined, ctx);
  const edited = await read.execute('read2', { path: 'round.txt' }, undefined, undefined, ctx);
  if (edited.content[0].text !== 'hello\nremote\n') throw new Error('edit output mismatch');

  const executable = join(remoteCwd, "script with 'quote.sh");
  writeFileSync(executable, 'before\n', { mode: 0o751 });
  const alias = join(remoteCwd, 'script-link');
  symlinkSync("script with 'quote.sh", alias);
  const hardLink = join(remoteCwd, 'script-hard-link');
  linkSync(executable, hardLink);
  const metadata = (path) => {
    const { mode, uid, gid, ino } = statSync(path);
    return { mode, uid, gid, ino };
  };
  const before = metadata(executable);
  await write.execute('write-executable', { path: executable, content: 'written\n' }, undefined, undefined, ctx);
  assert.deepEqual(metadata(executable), before);
  await edit.execute('edit-link', { path: alias, edits: [{ oldText: 'written', newText: 'edited' }] }, undefined, undefined, ctx);
  assert.ok(lstatSync(alias).isSymbolicLink());
  assert.deepEqual(metadata(alias), before);
  assert.equal(readFileSync(executable, 'utf8'), 'edited\n');
  assert.equal(readFileSync(hardLink, 'utf8'), 'edited\n');
  await assert.rejects(write.execute('write-directory', { path: remoteCwd, content: 'no' }, undefined, undefined, ctx), /not a regular file/);

  // A failed final copy must report failure and still clean up its temporary file.
  const brokenLink = join(remoteCwd, 'broken-link');
  symlinkSync('missing-directory/target', brokenLink);
  await assert.rejects(write.execute('write-broken-link', { path: brokenLink, content: 'no' }, undefined, undefined, ctx), /failed/);
  assert.ok(lstatSync(brokenLink).isSymbolicLink());
  assert.ok(!readdirSync(remoteCwd).some((name) => name.includes('.tmp.')));

  const userBash = await runner.emitUserBash({ type: 'user_bash', command: 'printf remote', cwd: process.cwd(), excludeFromContext: false });
  const output = [];
  assert.deepEqual(await userBash.operations.exec('printf remote', process.cwd(), { onData: (data) => output.push(data) }), { exitCode: 0 });
  assert.equal(Buffer.concat(output).toString(), 'remote');

  const elevate = runner.getToolDefinition('remote_admin_elevate');
  await elevate.execute('elevate-1', {}, undefined, undefined, ctx);
  const moshiRequestFile = `${moshiEventsFile}.request`;
  const moshiResolvedFile = `${moshiEventsFile}.resolved`;
  for (let attempt = 0; attempt < 50 && (!existsSync(moshiRequestFile) || !existsSync(moshiResolvedFile)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const moshiRequest = JSON.parse(readFileSync(moshiRequestFile, 'utf8'));
  const moshiResolved = JSON.parse(readFileSync(moshiResolvedFile, 'utf8'));
  if (moshiRequest.hook_event_name !== 'PermissionRequest' || moshiRequest.tool_use_id !== 'elevate-1') {
    throw new Error('Moshi permission request mismatch');
  }
  if (moshiResolved.hook_event_name !== 'PermissionResolved' || moshiResolved.approved !== true) {
    throw new Error('Moshi permission resolution mismatch');
  }

  await write.execute('elevated-write', { path: alias, content: 'elevated\n' }, undefined, undefined, ctx);
  assert.ok(lstatSync(alias).isSymbolicLink());
  assert.deepEqual(metadata(executable), before);
  assert.equal(readFileSync(hardLink, 'utf8'), 'elevated\n');
  await runner.emit({ type: 'session_shutdown', reason: 'reload' });

  const sshCount = readFileSync(countFile, 'utf8').trim();
  if (sshCount !== '2') throw new Error(`expected normal and elevated SSH processes, got ${sshCount}`);

  // Authentication failure must intercept both ! and !! rather than run locally.
  runner.setUIContext(makeUi('wrong-password'));
  await runner.emit({ type: 'session_start', reason: 'reload' });
  for (const excludeFromContext of [false, true]) {
    const blocked = await runner.emitUserBash({ type: 'user_bash', command: 'touch must-not-run-locally', cwd: tmp, excludeFromContext });
    assert.equal(blocked.result.exitCode, 1);
    assert.match(blocked.result.output, /command was not run/);
    assert.equal(blocked.operations, undefined);
  }
  await assert.rejects(bash.execute('disconnected', { command: 'touch must-not-run-locally' }, undefined, undefined, ctx), /not connected/);
  assert.equal(existsSync(join(tmp, 'must-not-run-locally')), false);
  await runner.emit({ type: 'session_shutdown', reason: 'quit' });

  result.runtime.flagValues.delete('ssh');
  assert.equal(await runner.emitUserBash({ type: 'user_bash', command: 'printf local', cwd: tmp, excludeFromContext: false }), undefined);
  console.log('fake SSH smoke passed (routing, failed authentication, file metadata, symlinks, and elevation)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
