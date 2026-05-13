/**
 * pi-remote-admin
 *
 * Routes Pi's read/write/edit/bash tools to a remote SSH host using persistent
 * non-PTY shell transports. Pi itself, local config, skills, API keys, and
 * local_* tools remain local. The remote host does not need Pi installed.
 */

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

type ElevationScope = "agent-response" | "persistent";

type RemoteAdminConfig = {
	target: string;
	cwd: string;
	shell: string;
	sshArgs: string[];
	connectTimeoutMs: number;
	commandTimeoutMs: number;
	maxFileBytes: number;
	logElevatedOps: boolean;
};

type RunResult = {
	exitCode: number;
	output: string;
};

type RunOptions = {
	cwd?: string;
	timeoutMs?: number;
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	maxOutputBytes?: number;
};

type SshShellTransportConfig = {
	target: string;
	shell: string;
	sshArgs: string[];
	connectTimeoutMs: number;
	commandTimeoutMs: number;
	startupCommand?: string;
	startupReadyToken?: string;
	sudoPrompt?: string;
	getSudoPassword?: () => Promise<string | undefined>;
};

type PendingRun = {
	token: string;
	buffer: string;
	outputBytes: number;
	maxOutputBytes: number;
	timer?: NodeJS.Timeout;
	onData?: (data: Buffer) => void;
	resolve: (result: RunResult) => void;
	reject: (error: Error) => void;
};

type ElevatedLogEntry = {
	operation: string;
	summary: string;
	exitCode?: number;
	bytes?: number;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const PASSWORD_PASTE_START = "\x1b[200~";
const PASSWORD_PASTE_END = "\x1b[201~";
const REMOTE_ADMIN_TOOL_NAMES = ["read", "write", "edit", "bash", "local_read", "local_write", "local_edit", "local_bash", "remote_admin_elevate"];

function randomToken(prefix = "__PI_REMOTE_ADMIN_END"): string {
	return `${prefix}_${randomBytes(18).toString("hex")}__`;
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function oneLine(value: string, max = 240): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function parsePositiveInt(value: unknown, defaultValue: number): number {
	if (value === undefined || value === null || value === "") return defaultValue;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected positive number, got ${String(value)}`);
	return Math.floor(parsed);
}

function parseBool(value: unknown): boolean {
	if (value === true) return true;
	if (value === false || value === undefined || value === null || value === "") return false;
	return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function splitSshArgs(value: unknown): string[] {
	if (value === undefined || value === null || value === "") return [];
	const values = Array.isArray(value) ? value : [value];
	return values.flatMap((v) => String(v).trim().split(/\s+/).filter(Boolean));
}

function parseSentinel(buffer: string, token: string): { output: string; exitCode: number } | null {
	const marker = `\n${token}:`;
	const markerIndex = buffer.indexOf(marker);
	if (markerIndex < 0) return null;

	const lineStart = markerIndex + 1;
	const lineEnd = buffer.indexOf("\n", lineStart);
	if (lineEnd < 0) return null;

	const line = buffer.slice(lineStart, lineEnd).replace(/\r$/, "");
	if (!line.startsWith(`${token}:`)) return null;
	const exitText = line.slice(token.length + 1);
	if (!/^-?\d+$/.test(exitText)) return null;

	return { output: buffer.slice(0, markerIndex), exitCode: Number(exitText) };
}

function isPermissionDenied(result: RunResult): boolean {
	return result.exitCode === 13 || /permission denied|operation not permitted/i.test(result.output);
}

function detectImageMimeTypeFromBuffer(buffer: Buffer): string | null {
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return null;
}

class SshShellTransport {
	private child: ChildProcessWithoutNullStreams | null = null;
	private pending: PendingRun | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private starting: Promise<void> | null = null;
	private closed = false;
	private stderrTail = "";
	private sudoPromptSeen = false;
	private sudoPromptActive = false;
	private startupBuffer = "";

	constructor(private readonly config: SshShellTransportConfig) {}

	isAlive(): boolean {
		return !!this.child && !this.child.killed && this.child.exitCode === null && !this.closed;
	}

	async start(): Promise<void> {
		if (this.isAlive()) return;
		if (this.starting) return this.starting;
		this.starting = this.startNow().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async startNow(): Promise<void> {
		this.closed = false;
		this.stderrTail = "";
		this.sudoPromptSeen = false;
		const args = [
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`ConnectTimeout=${Math.ceil(this.config.connectTimeoutMs / 1000)}`,
			...this.config.sshArgs,
			this.config.target,
			this.config.startupCommand ?? this.config.shell,
		];
		const child = spawn("ssh", args, { stdio: "pipe" });
		this.child = child;

		child.stdout.on("data", (data: Buffer) => this.handleStdout(data));
		child.stderr.on("data", (data: Buffer) => this.handleStderr(data));
		child.on("error", (error) => this.failPending(error));
		child.on("close", (code, signal) => {
			const error = new Error(`SSH transport closed${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
			this.child = null;
			this.failPending(error);
		});

		if (this.config.startupReadyToken) await this.waitForStartupReady(this.config.startupReadyToken);
	}

	private async waitForStartupReady(token: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			let deadline = Date.now() + this.config.commandTimeoutMs;

			const check = () => {
				if (this.startupBuffer.includes(`${token}\n`)) {
					this.startupBuffer = "";
					resolve();
					return;
				}

				if (!this.isAlive()) {
					reject(new Error(`remote shell exited during startup${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`));
					return;
				}

				// Do not count time spent in the local password popup as remote startup time.
				if (this.sudoPromptActive) deadline = Date.now() + this.config.commandTimeoutMs;
				if (Date.now() > deadline) {
					void this.close();
					reject(new Error(`remote shell startup timeout${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`));
					return;
				}

				setTimeout(check, 20).unref();
			};

			check();
		});
	}

	async run(command: string, options: RunOptions = {}): Promise<RunResult> {
		const runQueued = async () => {
			await this.start();
			return this.runUnqueued(command, options);
		};
		const result = this.queue.then(runQueued, runQueued);
		this.queue = result.catch(() => {});
		return result;
	}

	private runUnqueued(command: string, options: RunOptions): Promise<RunResult> {
		const child = this.child;
		if (!child || !this.isAlive()) throw new Error("SSH transport is not connected");
		if (this.pending) throw new Error("SSH transport already has an active command");

		const token = randomToken();
		const cwd = options.cwd ?? ".";
		const wrapper = [
			`if cd ${shQuote(cwd)}; then`,
			"(",
			command,
			") 2>&1",
			"__pi_remote_admin_status=$?",
			"else",
			"__pi_remote_admin_status=$?",
			"fi",
			`printf '\\n%s:%s\\n' ${shQuote(token)} "$__pi_remote_admin_status"`,
		].join("\n");

		return new Promise<RunResult>((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? this.config.commandTimeoutMs;
			const pending: PendingRun = {
				token,
				buffer: "",
				outputBytes: 0,
				maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
				onData: options.onData,
				resolve,
				reject,
			};

			const abort = () => {
				this.pending = null;
				if (pending.timer) clearTimeout(pending.timer);
				void this.close();
				reject(new Error("aborted"));
			};
			if (options.signal?.aborted) return abort();
			options.signal?.addEventListener("abort", abort, { once: true });

			pending.timer = setTimeout(() => {
				this.pending = null;
				void this.close();
				reject(new Error(`command timeout after ${timeoutMs}ms; SSH transport was restarted`));
			}, timeoutMs);

			const finish = (result: RunResult) => {
				if (pending.timer) clearTimeout(pending.timer);
				options.signal?.removeEventListener("abort", abort);
				resolve(result);
			};
			const fail = (error: Error) => {
				if (pending.timer) clearTimeout(pending.timer);
				options.signal?.removeEventListener("abort", abort);
				reject(error);
			};

			pending.resolve = finish;
			pending.reject = fail;
			this.pending = pending;
			child.stdin.write(`${wrapper}\n`);
		});
	}

	private handleStdout(data: Buffer): void {
		const pending = this.pending;
		if (!pending) {
			if (this.config.startupReadyToken) this.startupBuffer += data.toString("utf8");
			return;
		}
		pending.outputBytes += data.length;
		if (pending.outputBytes > pending.maxOutputBytes) {
			const error = new Error(`remote command output exceeded ${pending.maxOutputBytes} bytes; SSH transport was restarted`);
			this.pending = null;
			void this.close();
			pending.reject(error);
			return;
		}
		pending.buffer += data.toString("utf8");
		const parsed = parseSentinel(pending.buffer, pending.token);
		if (!parsed) return;

		this.pending = null;
		const output = parsed.output;
		pending.onData?.(Buffer.from(output, "utf8"));
		pending.resolve({ output, exitCode: parsed.exitCode });
	}

	private handleStderr(data: Buffer): void {
		const text = data.toString("utf8");
		this.stderrTail = (this.stderrTail + text).slice(-4000);
		const prompt = this.config.sudoPrompt;
		if (!prompt || this.sudoPromptSeen || !this.stderrTail.includes(prompt)) return;
		this.sudoPromptSeen = true;
		if (!this.config.getSudoPassword) return;
		void (async () => {
			this.sudoPromptActive = true;
			try {
				const password = await this.config.getSudoPassword?.();
				if (password === undefined) {
					void this.close();
					return;
				}
				this.child?.stdin.write(`${password}\n`);
			} finally {
				this.sudoPromptActive = false;
			}
		})();
	}

	private failPending(error: Error): void {
		const pending = this.pending;
		this.pending = null;
		if (!pending) return;
		if (pending.timer) clearTimeout(pending.timer);
		pending.reject(error);
	}

	async close(): Promise<void> {
		this.closed = true;
		const child = this.child;
		this.child = null;
		if (!child) return;
		child.stdin.destroy();
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 1000).unref();
	}
}

class ElevationManager {
	private transport: SshShellTransport | null = null;
	private scope: ElevationScope | null = null;
	private responseScopeDescription = "this agent response";

	constructor(
		private readonly config: RemoteAdminConfig,
		private readonly promptPassword: (ctx: ExtensionCommandContext | ExtensionContext, prompt: string) => Promise<string | undefined>,
		private readonly log: (entry: ElevatedLogEntry) => void,
	) {}

	isActive(): boolean {
		return !!this.transport && this.transport.isAlive();
	}

	describe(): string {
		if (!this.isActive()) return "inactive";
		return this.scope === "persistent" ? "persistent" : this.responseScopeDescription;
	}

	getTransport(): SshShellTransport | null {
		return this.isActive() ? this.transport : null;
	}

	async approve(ctx: ExtensionCommandContext | ExtensionContext, responseScopeDescription = "this agent response"): Promise<SshShellTransport> {
		if (this.isActive() && this.transport) return this.transport;
		const responseOption = `Just for ${responseScopeDescription}`;
		const choice = await ctx.ui.select("Approve elevated remote session?", [responseOption, "Persistent until revoked", "No"]);
		if (choice === undefined || choice === "No") throw new Error("Elevated remote session was not approved");
		const scope: ElevationScope = choice === "Persistent until revoked" ? "persistent" : "agent-response";

		const sudoPrompt = randomToken("__PI_REMOTE_ADMIN_SUDO_PROMPT");
		const readyToken = randomToken("__PI_REMOTE_ADMIN_ROOT_READY");
		const startupScript = `printf '%s\\n' ${shQuote(readyToken)}; exec ${shQuote(this.config.shell)}`;
		const startupCommand = `sudo -S -p ${shQuote(sudoPrompt)} ${shQuote(this.config.shell)} -c ${shQuote(startupScript)}`;
		let passwordRequested = false;
		const transport = new SshShellTransport({
			...this.config,
			startupCommand,
			startupReadyToken: readyToken,
			sudoPrompt,
			getSudoPassword: async () => {
				passwordRequested = true;
				return this.promptPassword(ctx, `Sudo password for ${this.config.target}`);
			},
		});

		try {
			await transport.start();
			const result = await transport.run("id -u", { timeoutMs: this.config.commandTimeoutMs, maxOutputBytes: 4096 });
			if (result.exitCode !== 0 || result.output.trim() !== "0") {
				throw new Error(`sudo did not start a root shell${result.output.trim() ? `: ${result.output.trim()}` : ""}`);
			}
		} catch (error) {
			await transport.close();
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(passwordRequested ? `sudo authentication failed: ${reason}` : `failed to start elevated shell: ${reason}`);
		}

		await this.revoke("replaced");
		this.transport = transport;
		this.scope = scope;
		this.responseScopeDescription = responseScopeDescription;
		this.log({ operation: "active", summary: `elevated transport active for ${this.describe()}` });
		return transport;
	}

	async revokeAgentResponse(): Promise<void> {
		if (this.scope === "agent-response") await this.revoke("agent response ended");
	}

	async revoke(reason = "revoked"): Promise<void> {
		const transport = this.transport;
		this.transport = null;
		this.scope = null;
		this.responseScopeDescription = "this agent response";
		if (transport) await transport.close();
		if (reason !== "replaced") this.log({ operation: reason, summary: "elevated transport closed" });
	}
}

function requireOk(result: RunResult, action: string): string {
	if (result.exitCode !== 0) {
		const output = result.output.trim();
		const suffix = isPermissionDenied(result) ? "\nElevation may be required. Use /remote-admin-elevate or the remote_admin_elevate tool, then retry." : "";
		throw new Error(`${action} failed (${result.exitCode})${output ? `: ${output}` : ""}${suffix}`);
	}
	return result.output;
}

function createPathMapper(localCwd: string, remoteCwd: string): (p: string) => string {
	const normalizedLocal = path.resolve(localCwd);
	return (p: string) => {
		const resolved = path.resolve(p);
		if (resolved === normalizedLocal) return remoteCwd;
		if (resolved.startsWith(normalizedLocal + path.sep)) return remoteCwd + resolved.slice(normalizedLocal.length);
		return p;
	};
}

type SelectedTransport = {
	transport: SshShellTransport;
	elevated: boolean;
};

type RemoteContext = {
	config: RemoteAdminConfig;
	toRemote: (p: string) => string;
	selectTransport: () => SelectedTransport;
	logElevated: (entry: ElevatedLogEntry) => void;
};

function base64ReadCommand(remotePath: string, maxBytes: number): string {
	return [
		`p=${shQuote(remotePath)}`,
		`test -e "$p" || { echo "not found: $p"; exit 2; }`,
		`test -f "$p" || { echo "not a regular file: $p"; exit 1; }`,
		`test -r "$p" || { echo "permission denied: $p"; exit 13; }`,
		`size=$(stat -c %s "$p") || exit $?`,
		`case "$size" in *[!0-9]*|'') echo "invalid file size: $size"; exit 1;; esac`,
		`if [ "$size" -gt ${maxBytes} ]; then echo "file too large: $size bytes (max ${maxBytes})"; exit 27; fi`,
		`if base64 -w 0 "$p" 2>/dev/null; then :; else base64 "$p" | tr -d '\\n'; fi`,
	].join("\n");
}

function base64WriteCommand(remotePath: string, content: Buffer): string {
	const b64 = content.toString("base64").replace(/(.{76})/g, "$1\n");
	const tag = randomToken("__PI_REMOTE_ADMIN_FILE_B64");
	return [
		`p=${shQuote(remotePath)}`,
		`dir=${"${p%/*}"}`,
		`base=${"${p##*/}"}`,
		`if [ "$dir" = "$p" ]; then dir=.; fi`,
		`mkdir -p "$dir" || exit $?`,
		`tmp=$(mktemp "$dir/.$base.tmp.XXXXXX") || exit $?`,
		`trap 'rm -f "$tmp" "$tmp.b64"' EXIT HUP INT TERM`,
		`cat > "$tmp.b64" <<'${tag}'`,
		b64,
		tag,
		`if base64 -d < "$tmp.b64" > "$tmp" 2>/dev/null; then :; else base64 --decode < "$tmp.b64" > "$tmp" || exit $?; fi`,
		`rm -f "$tmp.b64"`,
		`if [ -e "$p" ]; then chmod --reference="$p" "$tmp" 2>/dev/null || true; chown --reference="$p" "$tmp" 2>/dev/null || true; fi`,
		`mv "$tmp" "$p" || exit $?`,
		`trap - EXIT HUP INT TERM`,
	].join("\n");
}

function createRemoteReadOps(context: RemoteContext): ReadOperations {
	return {
		readFile: async (p) => {
			const remotePath = context.toRemote(p);
			const selected = context.selectTransport();
			const output = requireOk(
				await selected.transport.run(base64ReadCommand(remotePath, context.config.maxFileBytes), { cwd: context.config.cwd, maxOutputBytes: context.config.maxFileBytes * 2 }),
				`read ${remotePath}`,
			).replace(/\s+/g, "");
			const buffer = Buffer.from(output, "base64");
			if (selected.elevated) context.logElevated({ operation: "read", summary: remotePath, bytes: buffer.length, exitCode: 0 });
			return buffer;
		},
		access: async (p) => {
			const remotePath = context.toRemote(p);
			const selected = context.selectTransport();
			requireOk(await selected.transport.run(`p=${shQuote(remotePath)}\ntest -r "$p"`, { cwd: context.config.cwd, maxOutputBytes: 4096 }), `access ${remotePath}`);
		},
		detectImageMimeType: async (p) => {
			const remotePath = context.toRemote(p);
			const selected = context.selectTransport();
			const output = requireOk(
				await selected.transport.run(base64ReadCommand(remotePath, context.config.maxFileBytes), { cwd: context.config.cwd, maxOutputBytes: context.config.maxFileBytes * 2 }),
				`mime ${remotePath}`,
			).replace(/\s+/g, "");
			return detectImageMimeTypeFromBuffer(Buffer.from(output, "base64"));
		},
	};
}

function createRemoteWriteOps(context: RemoteContext): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const remotePath = context.toRemote(p);
			const buffer = Buffer.from(content, "utf8");
			if (buffer.length > context.config.maxFileBytes) throw new Error(`write ${remotePath} failed: content is ${buffer.length} bytes; max is ${context.config.maxFileBytes}`);
			const selected = context.selectTransport();
			requireOk(await selected.transport.run(base64WriteCommand(remotePath, buffer), { cwd: context.config.cwd, maxOutputBytes: 1024 * 1024 }), `write ${remotePath}`);
			if (selected.elevated) context.logElevated({ operation: "write", summary: remotePath, bytes: buffer.length, exitCode: 0 });
		},
		mkdir: async (dir) => {
			const remoteDir = context.toRemote(dir);
			const selected = context.selectTransport();
			requireOk(await selected.transport.run(`mkdir -p ${shQuote(remoteDir)}`, { cwd: context.config.cwd, maxOutputBytes: 4096 }), `mkdir ${remoteDir}`);
			if (selected.elevated) context.logElevated({ operation: "mkdir", summary: remoteDir, exitCode: 0 });
		},
	};
}

function createRemoteEditOps(context: RemoteContext): EditOperations {
	const read = createRemoteReadOps(context);
	const write = createRemoteWriteOps(context);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: async (p) => {
			const remotePath = context.toRemote(p);
			const selected = context.selectTransport();
			requireOk(await selected.transport.run(`p=${shQuote(remotePath)}\ntest -r "$p" && test -w "$p"`, { cwd: context.config.cwd, maxOutputBytes: 4096 }), `edit access ${remotePath}`);
		},
	};
}

function createRemoteBashOps(context: RemoteContext): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const remoteCwd = context.toRemote(cwd);
			const selected = context.selectTransport();
			const result = await selected.transport.run(command, {
				cwd: remoteCwd,
				timeoutMs: timeout ? timeout * 1000 : context.config.commandTimeoutMs,
				onData,
				signal,
			});
			if (selected.elevated) context.logElevated({ operation: "bash", summary: oneLine(command), exitCode: result.exitCode });
			return { exitCode: result.exitCode };
		},
	};
}

function replaceToolTitle(originalName: string, displayName: string, text: string): string {
	return text === originalName ? displayName : text;
}

function renderPasswordDialog(prompt: string, passwordLength: number, width: number): string[] {
	const innerWidth = Math.max(20, width - 2);
	const inputWidth = Math.max(12, Math.min(innerWidth - 4, 60));
	const masked = "•".repeat(passwordLength).slice(-inputWidth).padEnd(inputWidth, " ");
	const line = (text: string) => `│ ${text.slice(0, innerWidth - 2).padEnd(innerWidth - 2, " ")} │`;
	return [
		`╭${"─".repeat(innerWidth)}╮`,
		line("Remote sudo password"),
		line(prompt),
		line(`[${masked}]`),
		line("Enter to submit · Esc to cancel"),
		`╰${"─".repeat(innerWidth)}╯`,
	];
}

function stripControlChars(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, "");
}

function renderCallWithToolName<TDefinition extends ToolDefinition<any, any, any>>(
	definition: TDefinition,
	toolName: string | (() => string),
): TDefinition["renderCall"] {
	const renderCall = definition.renderCall!;
	const name = () => (typeof toolName === "function" ? toolName() : toolName);
	if (definition.name === "bash") {
		return ((args, theme, context) => {
			const component = renderCall(args, theme, context);
			const command = typeof args?.command === "string" ? args.command : "";
			const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
			const commandDisplay = command || theme.fg("toolOutput", "...");
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			(component as { setText(text: string): void }).setText(theme.fg("toolTitle", theme.bold(`${name()} $ ${commandDisplay}`)) + timeoutSuffix);
			return component;
		}) as TDefinition["renderCall"];
	}
	return ((args, theme, context) => {
		const titleTheme = new Proxy(theme, {
			get(target, prop, receiver) {
				if (prop !== "bold") {
					const value = Reflect.get(target, prop, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return (text: string) => target.bold(replaceToolTitle(definition.name, name(), text));
			},
		});
		return renderCall(args, titleTheme as Theme, context);
	}) as TDefinition["renderCall"];
}

type RemoteState = {
	config: RemoteAdminConfig;
	normalTransport: SshShellTransport;
	elevation: ElevationManager;
	context: RemoteContext;
	readTool: ReturnType<typeof createReadTool>;
	writeTool: ReturnType<typeof createWriteTool>;
	editTool: ReturnType<typeof createEditTool>;
	bashTool: ReturnType<typeof createBashTool>;
};

async function promptMaskedPassword(ctx: ExtensionCommandContext | ExtensionContext, prompt: string): Promise<string | undefined> {
	if (!ctx.hasUI) throw new Error("Sudo password prompt requires interactive mode");
	return ctx.ui.custom<string | undefined>(
		(tui, _theme, keybindings, done) => {
			let password = "";
			let pasteBuffer = "";
			let inPaste = false;
			let closed = false;

			const close = (value: string | undefined) => {
				if (closed) return;
				closed = true;
				password = "";
				done(value);
			};

			const appendPrintable = (text: string) => {
				const printable = stripControlChars(text);
				if (!printable) return;
				password += printable;
				tui.requestRender();
			};

			const consumePaste = (data: string): string | undefined => {
				if (data.includes(PASSWORD_PASTE_START)) {
					inPaste = true;
					pasteBuffer = "";
					data = data.slice(data.indexOf(PASSWORD_PASTE_START) + PASSWORD_PASTE_START.length);
				}
				if (!inPaste) return data;

				pasteBuffer += data;
				const end = pasteBuffer.indexOf(PASSWORD_PASTE_END);
				if (end === -1) return undefined;

				const pasted = pasteBuffer.slice(0, end);
				pasteBuffer = "";
				inPaste = false;
				return pasted;
			};

			return {
				render: (width: number) => renderPasswordDialog(prompt, password.length, width),
				handleInput(data: string): void {
					if (keybindings.matches(data, "tui.select.cancel") || data === "\x03") return close(undefined);
					if (keybindings.matches(data, "tui.input.submit") || data === "\r" || data === "\n") return close(password);

					const text = consumePaste(data);
					if (text === undefined) return;

					// Ignore terminal escape sequences such as mouse clicks, focus events,
					// and cursor keys. Without this, SGR mouse reports like ESC [ < ... M
					// can become literal password text.
					if (text.includes("\x1b")) return;

					if (keybindings.matches(text, "tui.editor.deleteCharBackward") || text === "\x7f" || text === "\b") {
						password = password.slice(0, -1);
						tui.requestRender();
						return;
					}

					appendPrintable(text);
				},
				invalidate() {},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "60%",
				minWidth: 44,
				anchor: "center",
			},
		},
	);
}

async function createRemoteState(config: RemoteAdminConfig, localCwd: string, pi: ExtensionAPI): Promise<RemoteState> {
	const normalTransport = new SshShellTransport(config);
	await normalTransport.start();
	const requirements = await normalTransport.run(
		[
			"command -v cat >/dev/null || exit 127",
			"command -v mv >/dev/null || exit 127",
			"command -v mkdir >/dev/null || exit 127",
			"command -v rm >/dev/null || exit 127",
			"command -v mktemp >/dev/null || exit 127",
			"command -v base64 >/dev/null || exit 127",
			"command -v chmod >/dev/null || exit 127",
			"command -v chown >/dev/null || exit 127",
			"command -v stat >/dev/null || exit 127",
			"printf x | base64 >/dev/null || exit 127",
		].join("\n"),
		{ timeoutMs: config.commandTimeoutMs, maxOutputBytes: 4096 },
	);
	if (requirements.exitCode !== 0) throw new Error(`remote requirements check failed: ${requirements.output.trim() || requirements.exitCode}`);

	let remoteCwd = config.cwd;
	if (!remoteCwd) {
		const pwd = await normalTransport.run("pwd", { maxOutputBytes: 4096 });
		if (pwd.exitCode !== 0) throw new Error(`failed to resolve remote cwd: ${pwd.output.trim()}`);
		remoteCwd = pwd.output.trim();
		config.cwd = remoteCwd;
	}
	const mkdir = await normalTransport.run(`mkdir -p ${shQuote(remoteCwd)} && cd ${shQuote(remoteCwd)} && pwd`, { maxOutputBytes: 4096 });
	if (mkdir.exitCode !== 0) throw new Error(`failed to prepare remote cwd: ${mkdir.output.trim()}`);
	config.cwd = mkdir.output.trim().split("\n").pop() || remoteCwd;

	let elevation: ElevationManager | undefined;
	const logElevated = (entry: ElevatedLogEntry) => {
		if (!config.logElevatedOps) return;
		const prefix = elevation?.isActive() ? `[root ${elevation.describe()}]` : `[root ${entry.operation}]`;
		const suffix = entry.bytes !== undefined ? ` ${entry.bytes} bytes` : entry.exitCode !== undefined ? ` exit ${entry.exitCode}` : "";
		pi.sendMessage({ content: `${prefix} ${entry.operation}: ${entry.summary}${suffix}`, display: true });
	};
	elevation = new ElevationManager(config, promptMaskedPassword, logElevated);
	const selectTransport = (): SelectedTransport => {
		const elevated = elevation?.getTransport();
		return elevated ? { transport: elevated, elevated: true } : { transport: normalTransport, elevated: false };
	};
	const context: RemoteContext = { config, toRemote: createPathMapper(localCwd, config.cwd), selectTransport, logElevated };
	return {
		config,
		normalTransport,
		elevation,
		context,
		readTool: createReadTool(localCwd, { operations: createRemoteReadOps(context) }),
		writeTool: createWriteTool(localCwd, { operations: createRemoteWriteOps(context) }),
		editTool: createEditTool(localCwd, { operations: createRemoteEditOps(context) }),
		bashTool: createBashTool(localCwd, { operations: createRemoteBashOps(context) }),
	};
}

function parseSshTarget(value: string): { target: string; cwd: string } {
	const [target, cwd = ""] = value.split(":", 2);
	if (!target) throw new Error("--ssh must be user@host or user@host:/path");
	return { target, cwd };
}

function buildConfig(pi: ExtensionAPI): RemoteAdminConfig | null {
	const ssh = pi.getFlag("ssh") as string | undefined;
	if (!ssh) return null;
	const { target, cwd } = parseSshTarget(ssh);
	return {
		target,
		cwd,
		shell: (pi.getFlag("shell") as string | undefined) || "/bin/sh",
		sshArgs: splitSshArgs(pi.getFlag("ssh-arg")),
		connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
		commandTimeoutMs: parsePositiveInt(pi.getFlag("command-timeout-ms"), DEFAULT_COMMAND_TIMEOUT_MS),
		maxFileBytes: parsePositiveInt(pi.getFlag("max-file-bytes"), DEFAULT_MAX_FILE_BYTES),
		logElevatedOps: parseBool(pi.getFlag("log-elevated-ops")),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });
	pi.registerFlag("shell", { description: "Remote shell (default: /bin/sh)", type: "string" });
	pi.registerFlag("max-file-bytes", { description: "Maximum remote file bytes for read/write (default: 25MiB)", type: "string" });
	pi.registerFlag("ssh-arg", { description: "Extra SSH arg(s)", type: "string" });
	pi.registerFlag("log-elevated-ops", { description: "Log elevated operation summaries", type: "boolean" });
	pi.registerFlag("command-timeout-ms", { description: "Default remote command timeout in milliseconds", type: "string" });

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	let remoteState: RemoteState | null = null;
	let toolsRegistered = false;
	let commandsRegistered = false;

	const requireRemote = (): RemoteState => {
		if (!remoteState) throw new Error("pi-remote-admin is not active; pass --ssh");
		return remoteState;
	};

	const setStatus = (ctx: ExtensionContext) => {
		if (!remoteState) return;
		const { config, normalTransport, elevation } = remoteState;
		const normal = normalTransport.isAlive() ? "connected" : "disconnected";
		const elevated = elevation.isActive() ? `root ${elevation.describe()}` : "root inactive";
		ctx.ui.setStatus("remote-admin", ctx.ui.theme.fg("accent", `Remote ${config.target}:${config.cwd} ${normal}, ${elevated}`));
	};

	const remoteToolName = (name: string) => (remoteState?.elevation.isActive() ? `root ${name}` : name);

	const registerTools = () => {
		if (toolsRegistered) return;
		toolsRegistered = true;

		pi.registerTool({
			...localRead,
			renderCall: renderCallWithToolName(localRead, () => remoteToolName("read")),
			async execute(id, params, signal, onUpdate, ctx) {
				const result = await requireRemote().readTool.execute(id, params, signal, onUpdate, ctx);
				setStatus(ctx);
				return result;
			},
		});

		pi.registerTool({
			...localWrite,
			renderCall: renderCallWithToolName(localWrite, () => remoteToolName("write")),
			async execute(id, params, signal, onUpdate, ctx) {
				const result = await requireRemote().writeTool.execute(id, params, signal, onUpdate, ctx);
				setStatus(ctx);
				return result;
			},
		});

		pi.registerTool({
			...localEdit,
			renderCall: renderCallWithToolName(localEdit, () => remoteToolName("edit")),
			async execute(id, params, signal, onUpdate, ctx) {
				const result = await requireRemote().editTool.execute(id, params, signal, onUpdate, ctx);
				setStatus(ctx);
				return result;
			},
		});

		pi.registerTool({
			...localBash,
			renderCall: renderCallWithToolName(localBash, () => remoteToolName("bash")),
			async execute(id, params, signal, onUpdate, ctx) {
				const result = await requireRemote().bashTool.execute(id, params, signal, onUpdate, ctx);
				setStatus(ctx);
				return result;
			},
		});

		pi.registerTool({
			...localRead,
			name: "local_read",
			label: "Local Read",
			renderCall: renderCallWithToolName(localRead, "local_read"),
			description: "Read a file from the local machine running Pi, bypassing remote-admin routing.",
			promptSnippet: "Read a file on the local machine running Pi, not the remote host.",
			execute: (id, params, signal, onUpdate, ctx) => localRead.execute(id, params, signal, onUpdate, ctx),
		});

		pi.registerTool({
			...localWrite,
			name: "local_write",
			label: "Local Write",
			renderCall: renderCallWithToolName(localWrite, "local_write"),
			description: "Write a file on the local machine running Pi, bypassing remote-admin routing.",
			promptSnippet: "Write a file on the local machine running Pi, not the remote host.",
			execute: (id, params, signal, onUpdate, ctx) => localWrite.execute(id, params, signal, onUpdate, ctx),
		});

		pi.registerTool({
			...localEdit,
			name: "local_edit",
			label: "Local Edit",
			renderCall: renderCallWithToolName(localEdit, "local_edit"),
			description: "Edit a file on the local machine running Pi, bypassing remote-admin routing.",
			promptSnippet: "Edit a file on the local machine running Pi, not the remote host.",
			execute: (id, params, signal, onUpdate, ctx) => localEdit.execute(id, params, signal, onUpdate, ctx),
		});

		pi.registerTool({
			...localBash,
			name: "local_bash",
			label: "Local Bash",
			renderCall: renderCallWithToolName(localBash, "local_bash"),
			description: "Run a shell command on the local machine running Pi, bypassing remote-admin routing.",
			promptSnippet: "Run a shell command on the local machine running Pi, not the remote host.",
			execute: (id, params, signal, onUpdate, ctx) => localBash.execute(id, params, signal, onUpdate, ctx),
		});

		pi.registerTool({
			name: "remote_admin_elevate",
			label: "Remote Admin Elevate",
			description: "Ask the human to approve an elevated root SSH session for remote-admin. The sudo password is prompted locally and is not shown to the model.",
			promptSnippet: "Request human approval for an elevated remote-admin root session when privileged remote operations are required.",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				const state = requireRemote();
				await state.elevation.approve(ctx);
				setStatus(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Elevated remote session active for ${state.elevation.describe()}. Default remote tools now use the root transport until the approved scope ends or it is revoked.`,
						},
					],
				};
			},
		});
	};

	const registerCommands = () => {
		if (commandsRegistered) return;
		commandsRegistered = true;
		pi.registerCommand("remote-admin-elevate", {
			description: "Approve an elevated root SSH session for remote-admin",
			handler: async (_args, ctx) => {
				const state = requireRemote();
				await ctx.waitForIdle();
				await state.elevation.approve(ctx, "next agent response");
				setStatus(ctx);
				ctx.ui.notify(`Elevated remote session active for ${state.elevation.describe()}`, "info");
			},
		});
		pi.registerCommand("remote-admin-revoke", {
			description: "Revoke the elevated remote-admin SSH session",
			handler: async (_args, ctx) => {
				const state = requireRemote();
				await state.elevation.revoke("revoked");
				setStatus(ctx);
				ctx.ui.notify("Elevated remote session revoked", "info");
			},
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		const config = buildConfig(pi);
		if (!config) return;
		registerTools();
		registerCommands();
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...REMOTE_ADMIN_TOOL_NAMES])]);
		try {
			remoteState = await createRemoteState(config, localCwd, pi);
			setStatus(ctx);
			ctx.ui.notify(`Remote admin connected: ${config.target}:${config.cwd}`, "info");
		} catch (error) {
			remoteState = null;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("remote-admin", ctx.ui.theme.fg("warning", `Remote admin failed: ${config.target}`));
			ctx.ui.notify(`Remote admin failed: ${message}`, "warning");
		}
	});

	pi.on("session_switch", (_event, ctx) => setStatus(ctx));

	pi.on("agent_end", async () => {
		await remoteState?.elevation.revokeAgentResponse();
	});

	pi.on("session_shutdown", async () => {
		if (!remoteState) return;
		await remoteState.elevation.revoke("shutdown");
		await remoteState.normalTransport.close();
		remoteState = null;
	});

	pi.on("user_bash", () => {
		if (!remoteState) return;
		return { operations: createRemoteBashOps(remoteState.context) };
	});

	pi.on("before_agent_start", (event) => {
		if (!remoteState) return;
		const { config, elevation } = remoteState;
		const remoteContext = [
			"Remote server context:",
			"You are connected to a remote server, while running on the user's local machine.",
			`- Remote host: ${config.target}`,
			`- Remote working directory: ${config.cwd}`,
			"- The normal read/write/edit/bash tools operate on the remote host over persistent SSH.",
			"- Use local_read/local_write/local_edit/local_bash for the local machine running Pi.",
			"- Elevation: available on approval. Use remote_admin_elevate or ask the user to run /remote-admin-elevate when privileged access is required.",
			elevation.isActive() ? `- Elevated root transport: active for ${elevation.describe()}.` : "- Elevated root transport: inactive.",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n${remoteContext}` };
	});
}
