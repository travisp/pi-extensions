#!/usr/bin/env node
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function getPiCodingAgentRoot() {
  const root = resolve(process.env.PI_CODING_AGENT_ROOT ?? 'node_modules/@earendil-works/pi-coding-agent');
  if (!existsSync(join(root, 'dist/core/extensions/loader.js'))) {
    throw new Error('Missing @earendil-works/pi-coding-agent. Run npm install --include=peer, or set PI_CODING_AGENT_ROOT.');
  }
  return root;
}

const piCodingAgentRoot = getPiCodingAgentRoot();
const importPiInternal = (relativePath) => import(pathToFileURL(join(piCodingAgentRoot, relativePath)).href);
const { discoverAndLoadExtensions } = await importPiInternal('dist/core/extensions/loader.js');
const { ExtensionRunner } = await importPiInternal('dist/core/extensions/runner.js');

const tmp = mkdtempSync(join(tmpdir(), 'pi-remote-ssh-admin-smoke-'));
const remoteCwd = join(tmp, 'remote');
const countFile = join(tmp, 'ssh-count');

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

function makeUi({ password } = {}) {
  const keybindings = {
    matches: (data, action) => {
      if (action === 'tui.input.submit') return data === '\r' || data === '\n';
      if (action === 'tui.select.cancel') return data === '\x1b';
      if (action === 'tui.editor.deleteCharBackward') return data === '\x7f' || data === '\b';
      return false;
    },
  };
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
    custom: async (factory) => {
      if (password === undefined) return undefined;
      let result;
      const component = factory({ requestRender: () => {} }, {}, keybindings, (value) => { result = value; });
      for (const char of password) component.handleInput?.(char);
      component.handleInput?.('\r');
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
  const result = await discoverAndLoadExtensions(['.'], process.cwd());
  result.runtime.flagValues.set('ssh', `fake:${remoteCwd}`);
  result.runtime.flagValues.set('use-password', true);
  const ext = result.extensions.find((e) => e.path.includes('remote-admin'));
  const runner = new ExtensionRunner([ext], result.runtime, process.cwd(), { getSessionFile: () => undefined }, { getApiKeyAndHeaders: async () => ({ ok: false }) });
  const ui = makeUi({ password: 'opensesame' });
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
  if (readResult.content[0].text !== 'hello\nworld\n') throw new Error(`read output mismatch: ${JSON.stringify(readResult.content)}`);

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
