#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAndLoadExtensions } from '/Users/travis/.nodenv/versions/22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { ExtensionRunner } from '/Users/travis/.nodenv/versions/22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js';

const tmp = mkdtempSync(join(tmpdir(), 'pi-remote-admin-smoke-'));
const bin = join(tmp, 'bin');
const remoteCwd = join(tmp, 'remote');
const countFile = join(tmp, 'ssh-count');

writeFileSync(join(tmp, 'ssh'), `#!/usr/bin/env bash
count_file=\${PI_FAKE_SSH_COUNT:-}
if [[ -n "$count_file" ]]; then
  n=0
  [[ -f "$count_file" ]] && n=$(cat "$count_file")
  echo $((n + 1)) > "$count_file"
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    -T|-tt) shift ;;
    -o|-p) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
remote="$1"; shift
cmd="$*"
exec bash -c "$cmd"
`);
chmodSync(join(tmp, 'ssh'), 0o755);

writeFileSync(join(tmp, 'stat'), `#!/usr/bin/env bash
if [[ "$1" == "-c" && "$2" == "%s" ]]; then
  /usr/bin/stat -f %z "$3"
else
  /usr/bin/stat "$@"
fi
`);
chmodSync(join(tmp, 'stat'), 0o755);

writeFileSync(join(tmp, 'base64'), `#!/usr/bin/env bash
if [[ "$1" == "-w" ]]; then
  shift 2
  /usr/bin/base64 -i "$1" | tr -d '\\n'
elif [[ "$1" == "-d" ]]; then
  /usr/bin/base64 -D
elif [[ "$1" == "--decode" ]]; then
  /usr/bin/base64 -D
elif [[ $# -eq 1 ]]; then
  /usr/bin/base64 -i "$1"
else
  /usr/bin/base64 "$@"
fi
`);
chmodSync(join(tmp, 'base64'), 0o755);

process.env.PATH = `${tmp}:${process.env.PATH}`;
process.env.PI_FAKE_SSH_COUNT = countFile;

function makeUi() {
  return {
    select: async () => undefined,
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
    custom: async () => undefined,
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
  const result = await discoverAndLoadExtensions(['.'], process.cwd());
  result.runtime.flagValues.set('host', 'fake');
  result.runtime.flagValues.set('cwd', remoteCwd);
  const ext = result.extensions.find((e) => e.path.includes('remote-admin'));
  const runner = new ExtensionRunner([ext], result.runtime, process.cwd(), { getSessionFile: () => undefined }, { getApiKeyAndHeaders: async () => ({ ok: false }) });
  const ui = makeUi();
  const ctx = { ui, hasUI: true };

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
  if (readResult.content[0].text !== 'hello\nworld\n') throw new Error('read output mismatch');

  const edit = runner.getToolDefinition('edit');
  await edit.execute('edit', { path: 'round.txt', edits: [{ oldText: 'world', newText: 'remote' }] }, undefined, undefined, ctx);
  const edited = await read.execute('read2', { path: 'round.txt' }, undefined, undefined, ctx);
  if (edited.content[0].text !== 'hello\nremote\n') throw new Error('edit output mismatch');

  await runner.emit({ type: 'session_shutdown' });

  const sshCount = readFileSync(countFile, 'utf8').trim();
  if (sshCount !== '1') throw new Error(`expected one persistent SSH process, got ${sshCount}`);
  console.log('fake SSH smoke passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
