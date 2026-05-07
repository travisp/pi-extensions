/**
 * SSH tmux remote execution extension.
 *
 * Routes Pi's default read/write/edit/bash tools through a persistent remote tmux pane over SSH.
 * This enables on-demand sudo approval by attaching to the same tmux session and
 * running `sudo -v`; subsequent agent commands can use `sudo -n` while the sudo
 * timestamp remains valid.
 *
 * Usage:
 *   pi -e ./pi-ssh-tmux --ssh-tmux user@host
 *   pi -e ./pi-ssh-tmux --ssh-tmux user@host:/remote/path
 *   pi -e ./pi-ssh-tmux --ssh-tmux user@host --tmux-name pi-work
 *
 * Requirements on remote:
 *   - ssh key-based auth
 *   - tmux
 *   - bash
 *   - base64
 *   - file
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createEditTool,
	createEditToolDefinition,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

type SshTmuxConfig = {
	remote: string;
	remoteCwd: string;
	session: string;
	shellIdleTimeoutSeconds: number;
};

type RunResult = {
	output: Buffer;
	exitCode: number | null;
};

type RunOptions = {
	signal?: AbortSignal;
	timeout?: number;
	onData?: (data: Buffer) => void;
	audit?: string;
};

const DEFAULT_SESSION = "pi-ssh-tmux";
const DEFAULT_SHELL_IDLE_TIMEOUT_SECONDS = 24 * 60 * 60;
const POLL_INTERVAL_MS = 120;
const SSH_TMUX_TOOL_NAMES = [
	"read",
	"write",
	"edit",
	"bash",
	"local_read",
	"local_write",
	"local_edit",
	"local_bash",
];

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomId(): string {
	return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function stripAnsi(input: string): string {
	// tmux capture usually returns plain text, but sudo and prompts can contain CSI escapes.
	return input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function oneLine(value: string, max = 240): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function audit(kind: string, detail: string): string {
	return `[pi ${kind}] ${oneLine(detail)}`;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseShellIdleTimeout(value: unknown): number {
	if (value === undefined || value === null || value === "") return DEFAULT_SHELL_IDLE_TIMEOUT_SECONDS;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--ssh-tmux-shell-timeout must be a non-negative integer");
	return parsed;
}

function parseTmuxName(value: unknown): string {
	if (value === undefined || value === null || value === "") return DEFAULT_SESSION;
	if (typeof value !== "string") throw new Error("--tmux-name must be a string");
	if (/[:\x00-\x1f\x7f]/.test(value)) throw new Error("--tmux-name must not contain ':' or control characters");
	return value;
}

const TERMINAL_NORMAL_MODE = [
	"\x1b[?1049l", // leave alternate screen
	"\x1b[r", // reset scroll margins
	"\x1b[?6l", // leave origin mode
	"\x1b[?25h", // show cursor
	"\x1b[?1000l", // disable mouse reporting
	"\x1b[?1002l",
	"\x1b[?1003l",
	"\x1b[?1006l",
	"\x1b[?1007l", // disable alternate-scroll mode
	"\x1b[0m", // reset attributes
].join("");

type TuiRenderState = {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
	requestRender: (force?: boolean) => void;
};

function resetTerminalScrollbackModes(): void {
	// tmux and footer/status-line extensions both manipulate terminal modes. Reset
	// the modes that affect scrollback before giving the terminal to ssh/tmux and
	// again before Pi's TUI resumes.
	process.stdout.write(TERMINAL_NORMAL_MODE);
}

function repaintTuiWithoutClearingScrollback(tui: unknown): void {
	// requestRender(true) clears terminal scrollback. Instead, reset the renderer's
	// bookkeeping so the next normal render repaints as an initial render.
	const state = tui as TuiRenderState;
	state.previousLines = [];
	state.previousWidth = 0;
	state.previousHeight = 0;
	state.cursorRow = 0;
	state.hardwareCursorRow = 0;
	state.maxLinesRendered = 0;
	state.previousViewportTop = 0;
	state.requestRender();
}

function sshExec(remote: string, command: string, input?: Buffer | string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const stdin = input === undefined ? "ignore" : "pipe";
		const child = spawn("ssh", [remote, command], { stdio: [stdin, "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(Buffer.from(data)));
		child.stderr.on("data", (data) => errChunks.push(Buffer.from(data)));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				const stderr = Buffer.concat(errChunks).toString().trim();
				const stdout = Buffer.concat(chunks).toString().trim();
				const details = [stderr && `stderr: ${stderr}`, stdout && `stdout: ${stdout}`].filter(Boolean).join("\n");
				reject(new Error(`SSH failed (${code}) while running on ${remote}:\n${command}${details ? `\n${details}` : ""}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
		if (input !== undefined) {
			child.stdin.end(input);
		}
	});
}

function parseSshTmuxArg(arg: string): { remote: string; remoteCwd?: string } {
	// Match the common `user@host:/absolute/path` form. Keep `host:path` aliases usable
	// by only treating the suffix as a path when it starts with `/`, `~`, or `.`.
	const match = arg.match(/^(.+?):([/~.].*)$/);
	if (!match) return { remote: arg };
	return { remote: match[1]!, remoteCwd: match[2]! };
}

function shQuotePathAllowTilde(value: string): string {
	if (value === "~") return "~";
	if (value.startsWith("~/")) return `~/${shQuote(value.slice(2))}`;
	return shQuote(value);
}

async function resolveRemoteCwd(remote: string, requested?: string): Promise<string> {
	if (!requested) return (await sshExec(remote, "pwd")).toString().trim();
	const expr = shQuotePathAllowTilde(requested);
	return (await sshExec(remote, `mkdir -p ${expr} && cd ${expr} && pwd`)).toString().trim();
}

class SshTmuxSession {
	private ready = false;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly config: SshTmuxConfig) {}

	markNotReady(): void {
		this.ready = false;
	}

	async ensure(): Promise<void> {
		const { remote, remoteCwd, session, shellIdleTimeoutSeconds } = this.config;
		if (this.ready) {
			const hasSession = await sshExec(remote, `tmux has-session -t ${shQuote(session)} 2>/dev/null && echo yes || echo no`);
			if (hasSession.toString().trim() === "yes") return;
			this.ready = false;
		}

		const requirements = [
			["tmux", "tmux. Install tmux on the remote host."],
			["bash", "bash."],
			["base64", "base64."],
			["file", "file."],
		];
		for (const [binary, message] of requirements) {
			await sshExec(remote, `command -v ${binary} >/dev/null || { echo ${shQuote(`Remote requirement missing: ${message}`)} >&2; exit 127; }`);
		}
		await sshExec(remote, `mkdir -p ${shQuote(remoteCwd)}`);

		const create = [
			`tmux has-session -t ${shQuote(session)} 2>/dev/null`,
			"||",
			`tmux new-session -d -s ${shQuote(session)} -c ${shQuote(remoteCwd)} ${shQuote("bash --noprofile --norc")}`,
		].join(" ");
		await sshExec(remote, create);
		await sshExec(remote, `tmux set-option -t ${shQuote(session)} history-limit 200000 >/dev/null`);
		await sshExec(remote, `tmux resize-window -t ${shQuote(session)} -x 1000 -y 60 >/dev/null`);

		const timeoutSetup = shellIdleTimeoutSeconds > 0 ? `export TMOUT=${shellIdleTimeoutSeconds}` : "unset TMOUT";

		// Quiet the pane so pasted commands are not echoed into captured output.
		await this.pasteToPane(`stty -echo\nexport PS1='[pi-ssh-tmux]$ '\n${timeoutSetup}\ncd ${shQuote(remoteCwd)}\n`);
		await sleep(150);
		this.ready = true;
	}

	async run(script: string, options: RunOptions = {}): Promise<RunResult> {
		const runQueued = async () => this.runUnqueued(script, options);
		const result = this.queue.then(runQueued, runQueued);
		this.queue = result.catch(() => {});
		return result;
	}

	private async runUnqueued(script: string, { signal, timeout, onData, audit }: RunOptions): Promise<RunResult> {
		await this.ensure();
		if (signal?.aborted) throw new Error("aborted");

		const id = randomId();
		const begin = `__PI_TMUX_BEGIN_${id}__`;
		const end = `__PI_TMUX_END_${id}__`;
		const wrapped = [
			`printf '%s\\n' ${shQuote(begin)}`,
			"(",
			"set +e",
			script,
			")",
			"__pi_tmux_rc=$?",
			`printf '%s:%s\\n' ${shQuote(end)} \"$__pi_tmux_rc\"`,
		].join("\n");

		const payloadPath = `/tmp/pi-tmux-${id}.b64`;
		const payload = Buffer.from(wrapped, "utf8").toString("base64").replace(/(.{76})/g, "$1\n");
		const paste = [
			`cat > ${shQuote(payloadPath)} <<'__PI_TMUX_PAYLOAD__'`,
			payload,
			"__PI_TMUX_PAYLOAD__",
			`base64 -d ${shQuote(payloadPath)} | bash`,
			`rm -f ${shQuote(payloadPath)}`,
			"",
		].join("\n");

		// If the user attached and left echo enabled, turn it off before pasting any
		// internal payload. The clear-line escape hides this one setup line in normal
		// terminals, avoiding large echoed heredocs/base64 while keeping attach simple.
		const quietPrefix = "stty -echo; printf '\\r\\033[K'\n";
		const auditedPaste = `${quietPrefix}${audit ? `printf '%s\\n' ${shQuote(audit)}\n` : ""}${paste}`;
		await this.pasteToPane(auditedPaste);

		let lastStreamed = 0;
		const started = Date.now();
		const onAbort = () => {
			void this.sendKeys("C-c").catch(() => {});
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			while (true) {
				if (signal?.aborted) return { output: Buffer.alloc(0), exitCode: null };
				if (timeout && Date.now() - started > timeout * 1000) {
					await this.sendKeys("C-c").catch(() => {});
					throw new Error(`timeout:${timeout}`);
				}

				const captured = stripAnsi((await this.capture()).toString("utf8"));
				const beginIndex = captured.lastIndexOf(begin);
				if (beginIndex >= 0) {
					const contentStart = captured.indexOf("\n", beginIndex);
					const afterBegin = contentStart >= 0 ? contentStart + 1 : beginIndex + begin.length;
					const endIndex = captured.indexOf(end, afterBegin);
					const current = endIndex >= 0 ? captured.slice(afterBegin, endIndex) : captured.slice(afterBegin);
					if (onData && current.length > lastStreamed) {
						onData(Buffer.from(current.slice(lastStreamed), "utf8"));
						lastStreamed = current.length;
					}
					if (endIndex >= 0) {
						const endLine = captured.slice(endIndex).split("\n", 1)[0];
						const match = endLine.match(new RegExp(`^${escapeRegex(end)}:(-?\\d+)`));
						const exitCode = match ? Number(match[1]) : null;
						return { output: Buffer.from(current.replace(/\n$/, ""), "utf8"), exitCode };
					}
				}
				await sleep(POLL_INTERVAL_MS);
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async pasteToPane(text: string): Promise<void> {
		const bufferName = `pi-${randomId()}`;
		const { remote, session } = this.config;
		await sshExec(remote, `tmux load-buffer -b ${shQuote(bufferName)} -`, text);
		await sshExec(remote, `tmux paste-buffer -b ${shQuote(bufferName)} -t ${shQuote(session)} && tmux delete-buffer -b ${shQuote(bufferName)}`);
	}

	private async sendKeys(...keys: string[]): Promise<void> {
		const quoted = keys.map(shQuote).join(" ");
		await sshExec(this.config.remote, `tmux send-keys -t ${shQuote(this.config.session)} ${quoted}`);
	}

	private async capture(): Promise<Buffer> {
		return sshExec(this.config.remote, `tmux capture-pane -J -p -t ${shQuote(this.config.session)} -S -`);
	}
}

function createPathMapper(localCwd: string, remoteCwd: string): (p: string) => string {
	const normalizedLocal = path.resolve(localCwd);
	return (p: string) => {
		const resolved = path.resolve(p);
		if (resolved === normalizedLocal) return remoteCwd;
		if (resolved.startsWith(normalizedLocal + path.sep)) {
			return remoteCwd + resolved.slice(normalizedLocal.length);
		}
		return p;
	};
}

type RemoteContext = {
	session: SshTmuxSession;
	localCwd: string;
	toRemote: (p: string) => string;
};

function createRemoteContext(session: SshTmuxSession, remoteCwd: string, localCwd: string): RemoteContext {
	return { session, localCwd, toRemote: createPathMapper(localCwd, remoteCwd) };
}

function requireOk(result: RunResult, action: string): Buffer {
	if (result.exitCode !== 0) {
		const output = result.output.toString("utf8").trim();
		throw new Error(`${action} failed${result.exitCode === null ? "" : ` (${result.exitCode})`}${output ? `: ${output}` : ""}`);
	}
	return result.output;
}

function createRemoteReadOps({ session, toRemote }: RemoteContext): ReadOperations {
	return {
		readFile: async (p) => {
			const remotePath = toRemote(p);
			const script = [
				`p=${shQuote(remotePath)}`,
				`if test -r "$p"; then base64 "$p"; else sudo -n base64 "$p"; fi`,
			].join("\n");
			const out = requireOk(await session.run(script, { audit: audit("read", remotePath) }), `read ${remotePath}`).toString("utf8").replace(/\s+/g, "");
			return Buffer.from(out, "base64");
		},
		access: async (p) => {
			const remotePath = toRemote(p);
			requireOk(await session.run(`p=${shQuote(remotePath)}\ntest -r "$p" || sudo -n test -r "$p"`), `access ${remotePath}`);
		},
		detectImageMimeType: async (p) => {
			const remotePath = toRemote(p);
			const out = requireOk(
				await session.run(`p=${shQuote(remotePath)}\nif test -r "$p"; then file --mime-type -b "$p"; else sudo -n file --mime-type -b "$p"; fi`),
				`mime ${remotePath}`,
			)
				.toString("utf8")
				.trim();
			return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(out) ? out : null;
		},
	};
}

function createRemoteWriteOps({ session, toRemote }: RemoteContext): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const remotePath = toRemote(p);
			const b64 = Buffer.from(content, "utf8").toString("base64").replace(/(.{76})/g, "$1\n");
			const script = [
				`p=${shQuote(remotePath)}`,
				`dir=$(dirname "$p")`,
				`tmp=$(mktemp)`,
				`cat > "$tmp.b64" <<'__PI_FILE_B64__'`,
				b64,
				"__PI_FILE_B64__",
				`base64 -d "$tmp.b64" > "$tmp"`,
				`rm -f "$tmp.b64"`,
				`if mkdir -p "$dir" 2>/dev/null && { { test -e "$p" && test -w "$p"; } || { ! test -e "$p" && test -w "$dir"; }; }; then`,
				`  mv "$tmp" "$p"`,
				`else`,
				`  sudo -n mkdir -p "$dir" && sudo -n tee "$p" >/dev/null < "$tmp"`,
				`  rc=$?; rm -f "$tmp"; exit "$rc"`,
				`fi`,
			].join("\n");
			requireOk(await session.run(script, { audit: audit("write", remotePath) }), `write ${remotePath}`);
		},
		mkdir: async (dir) => {
			const remoteDir = toRemote(dir);
			requireOk(await session.run(`d=${shQuote(remoteDir)}\nmkdir -p "$d" || sudo -n mkdir -p "$d"`, { audit: audit("mkdir", remoteDir) }), `mkdir ${remoteDir}`);
		},
	};
}

function createRemoteEditOps(context: RemoteContext): EditOperations {
	const read = createRemoteReadOps(context);
	const write = createRemoteWriteOps(context);
	const { session, toRemote } = context;
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: async (p) => {
			const remotePath = toRemote(p);
			requireOk(
				await session.run(`p=${shQuote(remotePath)}\n{ test -r "$p" && test -w "$p"; } || { sudo -n test -r "$p" && sudo -n test -w "$p"; }`),
				`edit access ${remotePath}`,
			);
		},
	};
}

function createRemoteBashOps({ session, toRemote }: RemoteContext): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const remoteCwdForCommand = toRemote(cwd);
			const script = `cd ${shQuote(remoteCwdForCommand)} && {\n${command}\n}`;
			const result = await session.run(script, { onData, signal, timeout, audit: audit("bash", command) });
			return { exitCode: result.exitCode };
		},
	};
}

function localToolTitle(toolName: string, localName: string, text: string): string {
	return text === toolName ? localName : text;
}

function renderCallWithLocalToolName<TDefinition extends ToolDefinition<any, any, any>>(
	definition: TDefinition,
	localName: string,
): TDefinition["renderCall"] {
	const renderCall = definition.renderCall!;

	if (definition.name === "bash") {
		return ((args, theme, context) => {
			const component = renderCall(args, theme, context);
			const command = typeof args?.command === "string" ? args.command : "";
			const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
			const commandDisplay = command || theme.fg("toolOutput", "...");
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			(component as { setText(text: string): void }).setText(
				theme.fg("toolTitle", theme.bold(`${localName} $ ${commandDisplay}`)) + timeoutSuffix,
			);
			return component;
		}) as TDefinition["renderCall"];
	}

	return ((args, theme, context) => {
		// read/write/edit renderers put the title through theme.bold(). Reuse the
		// original renderer and only swap that title to the local_* tool name.
		const localTitleTheme = new Proxy(theme, {
			get(target, prop, receiver) {
				if (prop !== "bold") {
					const value = Reflect.get(target, prop, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				}

				return (text: string) => target.bold(localToolTitle(definition.name, localName, text));
			},
		});
		return renderCall(args, localTitleTheme, context);
	}) as TDefinition["renderCall"];
}

type RemoteState = {
	config: SshTmuxConfig;
	context: RemoteContext;
	readTool: ReturnType<typeof createReadTool>;
	writeTool: ReturnType<typeof createWriteTool>;
	editTool: ReturnType<typeof createEditTool>;
	bashTool: ReturnType<typeof createBashTool>;
};

async function createRemoteState(config: SshTmuxConfig, localCwd: string): Promise<RemoteState> {
	const session = new SshTmuxSession(config);
	await session.ensure();

	const context = createRemoteContext(session, config.remoteCwd, localCwd);
	return {
		config,
		context,
		readTool: createReadTool(localCwd, { operations: createRemoteReadOps(context) }),
		writeTool: createWriteTool(localCwd, { operations: createRemoteWriteOps(context) }),
		editTool: createEditTool(localCwd, { operations: createRemoteEditOps(context) }),
		bashTool: createBashTool(localCwd, { operations: createRemoteBashOps(context) }),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh-tmux", { description: "SSH tmux remote: user@host or user@host:/path", type: "string" });
	pi.registerFlag("tmux-name", { description: "Remote tmux session name (default: pi-ssh-tmux)", type: "string" });
	pi.registerFlag("ssh-tmux-shell-timeout", {
		description: "Seconds of idle shell time before the remote tmux shell exits (default: 86400, 0 disables)",
		type: "string",
	});

	const localCwd = process.cwd();
	const localReadDefinition = createReadToolDefinition(localCwd);
	const localWriteDefinition = createWriteToolDefinition(localCwd);
	const localEditDefinition = createEditToolDefinition(localCwd);
	const localBashDefinition = createBashToolDefinition(localCwd);
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	let resolved: RemoteState | null = null;
	let sshTmuxRegistered = false;

	const requireRemote = (): RemoteState => {
		if (!resolved) throw new Error("--ssh-tmux is not active");
		return resolved;
	};

	const registerSshTmuxToolsAndCommands = () => {
		if (sshTmuxRegistered) return;
		sshTmuxRegistered = true;

		pi.registerTool({
			...localReadDefinition,
			async execute(id, params, signal, onUpdate) {
				return requireRemote().readTool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localWriteDefinition,
			async execute(id, params, signal, onUpdate) {
				return requireRemote().writeTool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localEditDefinition,
			async execute(id, params, signal, onUpdate) {
				return requireRemote().editTool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localBashDefinition,
			async execute(id, params, signal, onUpdate) {
				return requireRemote().bashTool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localReadDefinition,
			name: "local_read",
			label: "Local Read",
			renderCall: renderCallWithLocalToolName(localReadDefinition, "local_read"),
			description: "Read a file from the local machine running Pi, bypassing SSH tmux remote routing.",
			promptSnippet: "Read a file from the local machine running Pi, not the SSH tmux remote.",
			async execute(id, params, signal, onUpdate) {
				return localRead.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localWriteDefinition,
			name: "local_write",
			label: "Local Write",
			renderCall: renderCallWithLocalToolName(localWriteDefinition, "local_write"),
			description: "Write a file on the local machine running Pi, bypassing SSH tmux remote routing.",
			promptSnippet: "Write a file on the local machine running Pi, not the SSH tmux remote.",
			async execute(id, params, signal, onUpdate) {
				return localWrite.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localEditDefinition,
			name: "local_edit",
			label: "Local Edit",
			renderCall: renderCallWithLocalToolName(localEditDefinition, "local_edit"),
			description: "Edit a file on the local machine running Pi, bypassing SSH tmux remote routing.",
			promptSnippet: "Edit a file on the local machine running Pi, not the SSH tmux remote.",
			async execute(id, params, signal, onUpdate) {
				return localEdit.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localBashDefinition,
			name: "local_bash",
			label: "Local Bash",
			renderCall: renderCallWithLocalToolName(localBashDefinition, "local_bash"),
			description: "Run a shell command on the local machine running Pi, bypassing SSH tmux remote routing.",
			promptSnippet: "Run a shell command on the local machine running Pi, not the SSH tmux remote.",
			async execute(id, params, signal, onUpdate) {
				return localBash.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerCommand("ssh-tmux-attach", {
			description: "Suspend Pi and attach this terminal to the remote SSH tmux session",
			handler: async (_args, ctx) => {
				const remote = requireRemote();
				if (!ctx.hasUI) {
					ctx.ui.notify("/ssh-tmux-attach requires interactive mode", "warning");
					return;
				}

				await ctx.waitForIdle();
				await remote.context.session.ensure();

				const { config } = remote;
				await sshExec(config.remote, `tmux send-keys -t ${shQuote(config.session)} ${shQuote("stty echo; export PS1='[pi-ssh-tmux]$ '")} C-m`);
				await sleep(150);

				const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
					tui.stop();
					resetTerminalScrollbackModes();
					process.stdout.write("\x1b[2J\x1b[H");
					process.stdout.write(`Attaching to ${config.remote} tmux session ${config.session}. Detach with Ctrl-b then d (not Ctrl-d).\n\n`);

					let status: number | null = null;
					try {
						status = spawnSync("ssh", ["-tt", config.remote, `tmux attach -t ${shQuote(config.session)}`], { stdio: "inherit" }).status;
					} finally {
						resetTerminalScrollbackModes();
						tui.start();
						repaintTuiWithoutClearingScrollback(tui);
					}
					done(status);
					return { render: () => [], invalidate: () => {} };
				});

				if (exitCode === 0) ctx.ui.notify("Returned from SSH tmux session", "info");
				else ctx.ui.notify(`SSH tmux attach exited with code ${exitCode ?? "unknown"}`, "warning");
			},
		});

		pi.registerCommand("ssh-tmux-kill", {
			description: "Kill the remote SSH tmux session used by this extension",
			handler: async (_args, ctx) => {
				const remote = requireRemote();
				await ctx.waitForIdle();
				const { config } = remote;
				await sshExec(config.remote, `tmux kill-session -t ${shQuote(config.session)}`);
				remote.context.session.markNotReady();
				ctx.ui.notify(`Killed SSH tmux session ${config.session} on ${config.remote}`, "info");
				ctx.ui.setStatus("ssh-tmux", ctx.ui.theme.fg("warning", `SSH tmux killed: ${config.remote}:${config.remoteCwd}`));
			},
		});
	};

	const setSshTmuxStatus = (ctx: ExtensionContext) => {
		const remote = resolved;
		if (!remote) return;
		const { config } = remote;
		ctx.ui.setStatus("ssh-tmux", ctx.ui.theme.fg("accent", `SSH tmux: ${config.remote}:${config.remoteCwd}`));
	};

	pi.on("session_start", async (_event, ctx) => {
		const arg = pi.getFlag("ssh-tmux") as string | undefined;
		if (!arg) return;

		const parsed = parseSshTmuxArg(arg);
		const remoteCwd = await resolveRemoteCwd(parsed.remote, parsed.remoteCwd);
		const config: SshTmuxConfig = {
			remote: parsed.remote,
			remoteCwd,
			session: parseTmuxName(pi.getFlag("tmux-name")),
			shellIdleTimeoutSeconds: parseShellIdleTimeout(pi.getFlag("ssh-tmux-shell-timeout")),
		};
		resolved = await createRemoteState(config, localCwd);
		registerSshTmuxToolsAndCommands();
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...SSH_TMUX_TOOL_NAMES])]);

		setSshTmuxStatus(ctx);
		ctx.ui.notify(`SSH tmux mode: ${config.remote}:${config.remoteCwd} (${config.session})`, "info");
	});

	pi.on("session_switch", (_event, ctx) => {
		setSshTmuxStatus(ctx);
	});

	pi.on("user_bash", () => {
		if (!resolved) return;
		return { operations: createRemoteBashOps(resolved.context) };
	});

	pi.on("before_agent_start", async (event) => {
		const remote = resolved;
		if (!remote) return;
		const { config } = remote;
		const sudoHint = [
			"Remote execution is running through a persistent SSH tmux session.",
			`Current working directory: ${config.remoteCwd} (via SSH tmux: ${config.remote}, session ${config.session})`,
			"The normal read/write/edit/bash tools run on the SSH tmux remote; use local_read/local_write/local_edit/local_bash only for files or commands on the local machine running Pi.",
			"If privileged access is needed, use `sudo -n` so commands fail instead of prompting.",
			"The user can unlock sudo outside Pi by attaching to the same tmux session, running `sudo -v`, then detaching.",
		].join("\n");
		const modified = event.systemPrompt.replace(`Current working directory: ${localCwd}`, sudoHint);
		return { systemPrompt: modified };
	});
}
