/**
 * pi-remote-ssh-admin
 *
 * Routes Pi's read/write/edit/bash tools to a remote SSH host using persistent
 * non-PTY shell transports. Pi itself, local config, skills, API keys, and
 * local_* tools remain local. The remote host does not need Pi installed.
 */

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

type ElevationScope = "agent-response" | "persistent";

type RemoteAdminConfig = {
	target: string;
	cwd: string;
	sshArgs: string[];
	usePassword: boolean;
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
	sshArgs: string[];
	startupCommand?: string;
	startupReadyToken?: string;
	sudoPrompt?: string;
	getSudoPassword?: () => Promise<string | undefined>;
	promptSshPassword?: (prompt: string) => Promise<string | undefined>;
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

type MacSecureInputSession = {
	child: ChildProcess;
	tmpDir: string;
};

type SshAskPassSession = {
	env: Record<string, string>;
	close: () => Promise<void>;
};

const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const EMPTY_TOOL_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as unknown as ToolDefinition["parameters"];
const PASSWORD_PASTE_START = "\x1b[200~";
const PASSWORD_PASTE_END = "\x1b[201~";
const REMOTE_ADMIN_TOOL_NAMES = ["read", "write", "edit", "bash", "local_read", "local_write", "local_edit", "local_bash", "remote_admin_elevate"];

function randomToken(prefix = "__PI_REMOTE_ADMIN_END"): string {
	return `${prefix}_${randomBytes(18).toString("hex")}__`;
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
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

function rootShellScript(readyToken: string): string {
	return [`printf '%s\\n' ${shQuote(readyToken)}`, "shell=${SHELL:-/bin/sh}", 'exec "$shell"'].join("\n");
}

function sudoStartupCommand(args: string, readyToken: string): string {
	return `sudo ${args} /bin/sh -c ${shQuote(rootShellScript(readyToken))}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isSudoPasswordRequired(error: unknown): boolean {
	return /sudo:.*password.*required|password is required/i.test(errorMessage(error));
}

const SSH_ASKPASS_HELPER_SOURCE = `
const net = require("node:net");

const socketPath = process.env.PI_REMOTE_ADMIN_ASKPASS_SOCKET;
if (!socketPath) process.exit(1);

let response = "";
const client = net.createConnection(socketPath);
client.setEncoding("utf8");
client.on("connect", () => {
	client.write(JSON.stringify({ prompt: process.argv.slice(2).join(" ") }) + "\\n");
});
client.on("data", (chunk) => {
	response += chunk;
});
client.on("end", () => {
	try {
		const parsed = JSON.parse(response);
		if (typeof parsed.password !== "string") return process.exit(1);
		process.stdout.write(parsed.password);
	} catch {
		process.exit(1);
	}
});
client.on("error", () => process.exit(1));
`;

function formatSshPasswordPrompt(target: string, prompt: string): string {
	const trimmed = prompt.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
	return trimmed ? `${trimmed}\nTarget: ${target}` : `SSH password for ${target}`;
}

async function startSshAskPassSession(target: string, promptPassword: (prompt: string) => Promise<string | undefined>): Promise<SshAskPassSession> {
	const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pra-ap-"));
	let server: Server | undefined;
	try {
		const socketPath = path.join(tmpDir, "a.sock");
		const helperJsPath = path.join(tmpDir, "askpass.cjs");
		const helperPath = path.join(tmpDir, "askpass.sh");
		await writeFile(helperJsPath, SSH_ASKPASS_HELPER_SOURCE);
		await writeFile(helperPath, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(helperJsPath)} "$@"\n`);
		await Promise.all([chmod(helperJsPath, 0o700), chmod(helperPath, 0o700)]);

		let cancelled = false;
		const sockets = new Set<Socket>();
		const answer = (socket: Socket, password?: string) => socket.end(`${JSON.stringify(password === undefined ? {} : { password })}\n`);
		server = createServer((socket) => {
			sockets.add(socket);
			socket.setEncoding("utf8");
			socket.once("close", () => sockets.delete(socket));

			let request = "";
			socket.on("data", (chunk) => {
				request += chunk;
				const newline = request.indexOf("\n");
				if (newline < 0) return;
				socket.removeAllListeners("data");

				void (async () => {
					try {
						const parsed = JSON.parse(request.slice(0, newline)) as { prompt?: unknown };
						if (cancelled) return answer(socket);

						let password = await promptPassword(formatSshPasswordPrompt(target, typeof parsed.prompt === "string" ? parsed.prompt : ""));
						if (password === undefined) {
							cancelled = true;
							return answer(socket);
						}

						answer(socket, password);
						password = "";
					} catch {
						answer(socket);
					}
				})();
			});
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server!.once("error", onError);
			server!.listen(socketPath, () => {
				server!.off("error", onError);
				resolve();
			});
		});

		return {
			env: {
				SSH_ASKPASS: helperPath,
				SSH_ASKPASS_REQUIRE: "force",
				DISPLAY: process.env.DISPLAY || "pi-remote-admin",
				PI_REMOTE_ADMIN_ASKPASS_SOCKET: socketPath,
			},
			close: async () => {
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => server!.close(() => resolve()));
				await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
			},
		};
	} catch (error) {
		if (server) await new Promise<void>((resolve) => server!.close(() => resolve())).catch(() => undefined);
		await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

class SshShellTransport {
	private child: ChildProcessWithoutNullStreams | null = null;
	private pending: PendingRun | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private starting: Promise<void> | null = null;
	private closed = false;
	private stderrTail = "";
	private sudoPromptSeen = false;
	private startupBuffer = "";
	private askPassSession: SshAskPassSession | null = null;

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
		this.startupBuffer = "";
		await this.closeAskPassSession();
		const askPassSession = this.config.promptSshPassword ? await startSshAskPassSession(this.config.target, this.config.promptSshPassword) : null;
		this.askPassSession = askPassSession;
		const args = [
			"-T",
			"-o",
			askPassSession ? "BatchMode=no" : "BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`ConnectTimeout=${Math.ceil(CONNECT_TIMEOUT_MS / 1000)}`,
			...this.config.sshArgs,
			this.config.target,
			...(this.config.startupCommand ? [this.config.startupCommand] : []),
		];
		const child = spawn("ssh", args, {
			stdio: "pipe",
			env: askPassSession ? { ...process.env, ...askPassSession.env } : undefined,
		});
		this.child = child;

		child.stdout.on("data", (data: Buffer) => this.handleStdout(data));
		child.stderr.on("data", (data: Buffer) => this.handleStderr(data));
		child.on("error", (error) => {
			if (this.child !== child) return;
			void this.closeAskPassSession();
			this.failPending(error);
		});
		child.on("close", (code, signal) => {
			if (this.child !== child) return;
			void this.closeAskPassSession();
			const error = new Error(`SSH transport closed${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
			this.child = null;
			this.failPending(error);
		});

		if (this.config.startupReadyToken) await this.waitForStartupReady(this.config.startupReadyToken);
	}

	private async waitForStartupReady(token: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + COMMAND_TIMEOUT_MS;

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
			const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
			const pending: PendingRun = {
				token,
				buffer: "",
				outputBytes: 0,
				maxOutputBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
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
				reject(new Error(`command timeout after ${timeoutMs}ms; SSH transport was closed`));
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
			const error = new Error(`remote command output exceeded ${pending.maxOutputBytes} bytes; SSH transport was closed`);
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
			const password = await this.config.getSudoPassword?.();
			if (password === undefined) {
				void this.close();
				return;
			}
			this.child?.stdin.write(`${password}\n`);
		})();
	}

	private failPending(error: Error): void {
		const pending = this.pending;
		this.pending = null;
		if (!pending) return;
		if (pending.timer) clearTimeout(pending.timer);
		pending.reject(error);
	}

	private async closeAskPassSession(): Promise<void> {
		const session = this.askPassSession;
		this.askPassSession = null;
		if (!session) return;
		await session.close().catch(() => undefined);
	}

	async close(): Promise<void> {
		this.closed = true;
		const child = this.child;
		this.child = null;
		if (!child) {
			await this.closeAskPassSession();
			return;
		}
		child.stdin.destroy();
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 1000).unref();
		await this.closeAskPassSession();
	}
}

class ElevationManager {
	private transport: SshShellTransport | null = null;
	private scope: ElevationScope | null = null;
	private responseScopeDescription = "this agent response";

	constructor(
		private readonly config: RemoteAdminConfig,
		private readonly promptPassword: (ctx: ExtensionCommandContext | ExtensionContext, prompt: string, title?: string) => Promise<string | undefined>,
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
		await this.revoke();

		const responseOption = `Just for ${responseScopeDescription}`;
		const choice = await ctx.ui.select("Approve elevated remote session?", [responseOption, "Persistent until revoked", "No"]);
		if (!choice || choice === "No") throw new Error("Elevated remote session was not approved");

		const scope: ElevationScope = choice === "Persistent until revoked" ? "persistent" : "agent-response";
		let transport: SshShellTransport;

		try {
			transport = await this.startSudoTransport(ctx, "-n");
		} catch (error) {
			if (!isSudoPasswordRequired(error)) throw new Error(`failed to start elevated shell: ${errorMessage(error)}`);

			let password = await this.promptPassword(ctx, `Sudo password for ${this.config.target}`, "Remote sudo password");
			if (password === undefined) throw new Error("sudo authentication cancelled");

			try {
				const sudoPrompt = randomToken("__PI_REMOTE_ADMIN_SUDO_PROMPT");
				transport = await this.startSudoTransport(ctx, `-S -p ${shQuote(sudoPrompt)}`, sudoPrompt, async () => password);
			} catch (passwordError) {
				throw new Error(`sudo authentication failed: ${errorMessage(passwordError)}`);
			} finally {
				password = "";
			}
		}

		await this.revoke();
		this.transport = transport;
		this.scope = scope;
		this.responseScopeDescription = responseScopeDescription;
		return transport;
	}

	private async startSudoTransport(
		ctx: ExtensionCommandContext | ExtensionContext,
		sudoArgs: string,
		sudoPrompt?: string,
		getSudoPassword?: () => Promise<string | undefined>,
	): Promise<SshShellTransport> {
		const readyToken = randomToken("__PI_REMOTE_ADMIN_ROOT_READY");
		const transport = new SshShellTransport({
			...this.config,
			startupCommand: sudoStartupCommand(sudoArgs, readyToken),
			startupReadyToken: readyToken,
			sudoPrompt,
			getSudoPassword,
			promptSshPassword: this.config.usePassword ? (prompt) => this.promptPassword(ctx, prompt, "Remote SSH password") : undefined,
		});

		try {
			await transport.start();
			const result = await transport.run("id -u", { maxOutputBytes: 4096 });
			if (result.exitCode !== 0 || result.output.trim() !== "0") {
				throw new Error(`sudo did not start a root shell${result.output.trim() ? `: ${result.output.trim()}` : ""}`);
			}
			return transport;
		} catch (error) {
			await transport.close();
			throw error;
		}
	}

	async revokeAgentResponse(): Promise<void> {
		if (this.scope === "agent-response") await this.revoke();
	}

	async revoke(): Promise<void> {
		const transport = this.transport;
		this.transport = null;
		this.scope = null;
		this.responseScopeDescription = "this agent response";
		if (transport) await transport.close();
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

type RemoteContext = {
	cwd: string;
	toRemote: (p: string) => string;
	selectTransport: () => SshShellTransport;
};

function base64ReadCommand(remotePath: string): string {
	return [
		`p=${shQuote(remotePath)}`,
		`test -e "$p" || { echo "not found: $p"; exit 2; }`,
		`test -f "$p" || { echo "not a regular file: $p"; exit 1; }`,
		`test -r "$p" || { echo "permission denied: $p"; exit 13; }`,
		`size=$(wc -c < "$p" | tr -d '[:space:]') || exit $?`,
		`if [ "$size" -gt ${MAX_FILE_BYTES} ]; then echo "file too large: $size bytes (max ${MAX_FILE_BYTES})"; exit 27; fi`,
		`base64 < "$p" | tr -d '\\n'`,
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
		`base64 -d < "$tmp.b64" > "$tmp" || exit $?`,
		`rm -f "$tmp.b64"`,
		`mv "$tmp" "$p" || exit $?`,
		`trap - EXIT HUP INT TERM`,
	].join("\n");
}

function createRemoteReadOps(context: RemoteContext): ReadOperations {
	return {
		readFile: async (p) => {
			const remotePath = context.toRemote(p);
			const output = requireOk(
				await context.selectTransport().run(base64ReadCommand(remotePath), { cwd: context.cwd, maxOutputBytes: MAX_FILE_BYTES * 2 }),
				`read ${remotePath}`,
			);
			return Buffer.from(output, "base64");
		},
		access: async (p) => {
			const remotePath = context.toRemote(p);
			requireOk(await context.selectTransport().run(`p=${shQuote(remotePath)}\ntest -r "$p"`, { cwd: context.cwd, maxOutputBytes: 4096 }), `access ${remotePath}`);
		},
		detectImageMimeType: async (p) => {
			const remotePath = context.toRemote(p);
			const output = requireOk(
				await context.selectTransport().run(base64ReadCommand(remotePath), { cwd: context.cwd, maxOutputBytes: MAX_FILE_BYTES * 2 }),
				`mime ${remotePath}`,
			);
			return detectImageMimeTypeFromBuffer(Buffer.from(output, "base64"));
		},
	};
}

function createRemoteWriteOps(context: RemoteContext): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const remotePath = context.toRemote(p);
			const buffer = Buffer.from(content, "utf8");
			if (buffer.length > MAX_FILE_BYTES) throw new Error(`write ${remotePath} failed: content is ${buffer.length} bytes; max is ${MAX_FILE_BYTES}`);
			requireOk(await context.selectTransport().run(base64WriteCommand(remotePath, buffer), { cwd: context.cwd, maxOutputBytes: 1024 * 1024 }), `write ${remotePath}`);
		},
		mkdir: async (dir) => {
			const remoteDir = context.toRemote(dir);
			requireOk(await context.selectTransport().run(`mkdir -p ${shQuote(remoteDir)}`, { cwd: context.cwd, maxOutputBytes: 4096 }), `mkdir ${remoteDir}`);
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
			requireOk(await context.selectTransport().run(`p=${shQuote(remotePath)}\ntest -r "$p" && test -w "$p"`, { cwd: context.cwd, maxOutputBytes: 4096 }), `edit access ${remotePath}`);
		},
	};
}

function createRemoteBashOps(context: RemoteContext): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const remoteCwd = context.toRemote(cwd);
			const result = await context.selectTransport().run(command, {
				cwd: remoteCwd,
				timeoutMs: timeout ? timeout * 1000 : undefined,
				onData,
				signal,
			});
			return { exitCode: result.exitCode };
		},
	};
}

function renderPasswordDialog(title: string, prompt: string, passwordLength: number, width: number): string[] {
	const contentWidth = width - 4;
	const maskWidth = contentWidth - 2;
	const fit = (text: string) => {
		const fitted = truncateToWidth(text, contentWidth, "");
		return fitted + " ".repeat(contentWidth - visibleWidth(fitted));
	};
	const line = (text: string) => `│ ${fit(text)} │`;
	const masked = "•".repeat(passwordLength).slice(-maskWidth).padEnd(maskWidth, " ");

	return [
		`╭${"─".repeat(width - 2)}╮`,
		line(title),
		...prompt.split(/\r?\n/).map((part) => line(part.trim())),
		line(`[${masked}]`),
		line(contentWidth < 30 ? "↵ submit · Esc cancel" : "Enter to submit · Esc to cancel"),
		`╰${"─".repeat(width - 2)}╯`,
	];
}

const MAC_SECURE_INPUT_SOURCE = `
#include <Carbon/Carbon.h>
#include <signal.h>
#include <unistd.h>

static void stop(int signal) {
	DisableSecureEventInput();
	_exit(signal == 0 ? 0 : 128 + signal);
}

int main(void) {
	signal(SIGTERM, stop);
	EnableSecureEventInput();
	char buffer[64];
	while (read(STDIN_FILENO, buffer, sizeof(buffer)) > 0) {}
	stop(0);
}
`;

async function compileMacSecureInputHelper(binaryPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("cc", ["-x", "c", "-", "-framework", "Carbon", "-o", binaryPath], { stdio: ["pipe", "ignore", "ignore"] });
		child.stdin.on("error", () => undefined);
		const timer = setTimeout(() => child.kill(), 10_000);
		child.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
		child.stdin.end(MAC_SECURE_INPUT_SOURCE);
	});
}

async function startMacSecureInput(): Promise<MacSecureInputSession | undefined> {
	if (process.platform !== "darwin") return undefined;

	let tmpDir: string | undefined;
	try {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-admin-secure-input-"));
		const binaryPath = path.join(tmpDir, "secure-input");
		if (!(await compileMacSecureInputHelper(binaryPath))) throw new Error("compile failed");
		const child = spawn(binaryPath, [], { stdio: ["pipe", "ignore", "ignore"] });
		child.once("error", () => undefined);
		return { child, tmpDir };
	} catch {
		// Secure Keyboard Entry is best-effort.
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
		return undefined;
	}
}

async function stopMacSecureInput(session: MacSecureInputSession | undefined): Promise<void> {
	if (!session) return;
	try {
		session.child.stdin?.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				session.child.kill();
				resolve();
			}, 1000);
			session.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	} catch {
		// Best-effort cleanup.
	}
	await rm(session.tmpDir, { recursive: true, force: true }).catch(() => undefined);
}

async function withMacSecureInput<T>(fn: () => Promise<T>): Promise<T> {
	const session = await startMacSecureInput();
	try {
		return await fn();
	} finally {
		await stopMacSecureInput(session);
	}
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
				return (text: string) => target.bold(text === definition.name ? name() : text);
			},
		});
		return renderCall(args, titleTheme as Theme, context);
	}) as TDefinition["renderCall"];
}

type RemoteState = {
	config: RemoteAdminConfig;
	displayHost: string;
	normalTransport: SshShellTransport;
	elevation: ElevationManager;
	context: RemoteContext;
	readTool: ReturnType<typeof createReadToolDefinition>;
	writeTool: ReturnType<typeof createWriteToolDefinition>;
	editTool: ReturnType<typeof createEditToolDefinition>;
	bashTool: ReturnType<typeof createBashToolDefinition>;
};

async function promptMaskedPassword(ctx: ExtensionCommandContext | ExtensionContext, prompt: string, title = "Remote password"): Promise<string | undefined> {
	if (!ctx.hasUI) throw new Error("Password prompt requires interactive mode");
	return withMacSecureInput(() =>
		ctx.ui.custom<string | undefined>(
		(tui, _theme, keybindings, done) => {
			let password = "";

			const close = (value: string | undefined) => {
				password = "";
				done(value);
			};
			const append = (text: string) => {
				password += stripControlChars(text);
				tui.requestRender();
			};

			return {
				render: (width: number) => renderPasswordDialog(title, prompt, password.length, width),
				handleInput(data: string): void {
					if (data.startsWith(PASSWORD_PASTE_START) && data.endsWith(PASSWORD_PASTE_END)) {
						append(data.slice(PASSWORD_PASTE_START.length, -PASSWORD_PASTE_END.length));
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel") || data === "\x03") return close(undefined);
					if (keybindings.matches(data, "tui.input.submit")) return close(password);
					if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
						password = password.slice(0, -1);
						tui.requestRender();
						return;
					}

					const kittyPrintable = decodeKittyPrintable(data);
					if (kittyPrintable !== undefined) return append(kittyPrintable);

					// Ignore non-printing terminal sequences such as mouse and cursor input.
					if (data.includes("\x1b")) return;
					append(data);
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
	));
}

async function checkRemoteRequirements(transport: SshShellTransport): Promise<void> {
	const result = await transport.run(
		[
			"for bin in mv mkdir rm mktemp base64 wc tr; do command -v \"$bin\" >/dev/null || exit 127; done",
			"printf eA== | base64 -d >/dev/null || exit 127",
		].join("\n"),
		{ maxOutputBytes: 4096 },
	);
	if (result.exitCode !== 0) throw new Error(`remote requirements check failed: ${result.output.trim() || result.exitCode}`);
}

async function prepareRemoteCwd(transport: SshShellTransport, requestedCwd: string): Promise<string> {
	let cwd = requestedCwd;
	if (!cwd) {
		const pwd = await transport.run("pwd", { maxOutputBytes: 4096 });
		if (pwd.exitCode !== 0) throw new Error(`failed to resolve remote cwd: ${pwd.output.trim()}`);
		cwd = pwd.output.trim();
	}

	const result = await transport.run(`mkdir -p ${shQuote(cwd)} && cd ${shQuote(cwd)} && pwd`, { maxOutputBytes: 4096 });
	if (result.exitCode !== 0) throw new Error(`failed to prepare remote cwd: ${result.output.trim()}`);
	return result.output.trim();
}

async function resolveRemoteHostname(transport: SshShellTransport, fallback: string): Promise<string> {
	const result = await transport.run("hostname -f 2>/dev/null || hostname 2>/dev/null || uname -n 2>/dev/null", { maxOutputBytes: 4096 });
	const hostname = result.output.trim().split(/\r?\n/, 1)[0];
	return result.exitCode === 0 && hostname ? hostname : fallback;
}

async function createRemoteState(config: RemoteAdminConfig, localCwd: string, ctx: ExtensionContext): Promise<RemoteState> {
	if (config.usePassword && !ctx.hasUI) throw new Error("--use-password requires interactive mode");
	const normalTransport = new SshShellTransport({
		...config,
		promptSshPassword: config.usePassword ? (prompt) => promptMaskedPassword(ctx, prompt, "Remote SSH password") : undefined,
	});
	try {
		await checkRemoteRequirements(normalTransport);
		const [cwd, displayHost] = await Promise.all([
			prepareRemoteCwd(normalTransport, config.cwd),
			resolveRemoteHostname(normalTransport, config.target),
		]);
		const resolvedConfig = { ...config, cwd };

		const elevation = new ElevationManager(resolvedConfig, promptMaskedPassword);
		const selectTransport = (): SshShellTransport => elevation.getTransport() ?? normalTransport;
		const context: RemoteContext = { cwd: resolvedConfig.cwd, toRemote: createPathMapper(localCwd, resolvedConfig.cwd), selectTransport };
		return {
			config: resolvedConfig,
			displayHost,
			normalTransport,
			elevation,
			context,
			readTool: createReadToolDefinition(localCwd, { operations: createRemoteReadOps(context) }),
			writeTool: createWriteToolDefinition(localCwd, { operations: createRemoteWriteOps(context) }),
			editTool: createEditToolDefinition(localCwd, { operations: createRemoteEditOps(context) }),
			bashTool: createBashToolDefinition(localCwd, { operations: createRemoteBashOps(context) }),
		};
	} catch (error) {
		await normalTransport.close();
		throw error;
	}
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
		sshArgs: splitSshArgs(pi.getFlag("ssh-arg")),
		usePassword: Boolean(pi.getFlag("use-password")),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });
	pi.registerFlag("ssh-arg", { description: "Extra SSH arg(s)", type: "string" });
	pi.registerFlag("use-password", { description: "Prompt locally for SSH login password/key passphrase when used with --ssh", type: "boolean" });

	const localCwd = process.cwd();
	const localRead = createReadToolDefinition(localCwd);
	const localWrite = createWriteToolDefinition(localCwd);
	const localEdit = createEditToolDefinition(localCwd);
	const localBash = createBashToolDefinition(localCwd);
	let remoteState: RemoteState | null = null;

	const requireRemote = (): RemoteState => {
		if (!remoteState) throw new Error("pi-remote-ssh-admin is not active; pass --ssh");
		return remoteState;
	};

	const setStatus = (ctx: ExtensionContext) => {
		if (!remoteState) return;
		const { config, displayHost, elevation } = remoteState;
		const elevated = elevation.isActive() ? ` root ${elevation.describe()}` : "";
		ctx.ui.setStatus("remote-admin", `🌐 ${displayHost}:${config.cwd}${elevated}`);
	};

	const runAndRefreshStatus = async <T>(ctx: ExtensionContext, operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} finally {
			setStatus(ctx);
		}
	};

	const warnIfRtkExtensionLoaded = (ctx: ExtensionContext) => {
		if (!pi.getCommands().some((command) => command.name === "rtk")) return;
		ctx.ui.notify("pi-rtk-optimizer is loaded. If command rewrite mode is enabled, rewritten bash commands may fail on the remote host unless rtk is installed there; use /rtk to switch pi-rtk-optimizer to suggest mode.", "error");
	};

	const remoteToolName = (name: string) => (remoteState?.elevation.isActive() ? `root ${name}` : name);

	const registerTools = () => {
		pi.registerTool({
			...localRead,
			renderCall: renderCallWithToolName(localRead, () => remoteToolName("read")),
			execute: (id, params, signal, onUpdate, ctx) =>
				runAndRefreshStatus(ctx, () => requireRemote().readTool.execute(id, params, signal, onUpdate, ctx)),
		});

		pi.registerTool({
			...localWrite,
			renderCall: renderCallWithToolName(localWrite, () => remoteToolName("write")),
			execute: (id, params, signal, onUpdate, ctx) =>
				runAndRefreshStatus(ctx, () => requireRemote().writeTool.execute(id, params, signal, onUpdate, ctx)),
		});

		pi.registerTool({
			...localEdit,
			renderCall: renderCallWithToolName(localEdit, () => remoteToolName("edit")),
			execute: (id, params, signal, onUpdate, ctx) =>
				runAndRefreshStatus(ctx, () => requireRemote().editTool.execute(id, params, signal, onUpdate, ctx)),
		});

		pi.registerTool({
			...localBash,
			renderCall: renderCallWithToolName(localBash, () => remoteToolName("bash")),
			execute: (id, params, signal, onUpdate, ctx) =>
				runAndRefreshStatus(ctx, () => requireRemote().bashTool.execute(id, params, signal, onUpdate, ctx)),
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
			description: "Ask the human to approve an elevated root SSH session for remote-admin. If sudo requires a password, it is prompted locally and is not shown to the model.",
			promptSnippet: "Request human approval for an elevated remote-admin root session when privileged remote operations are required.",
			parameters: EMPTY_TOOL_PARAMETERS,
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				const state = requireRemote();
				return runAndRefreshStatus(ctx, async () => {
					await state.elevation.approve(ctx);
					return {
						content: [
							{
								type: "text",
								text: `Elevated remote session active for ${state.elevation.describe()}. Default remote tools now use the root transport until the approved scope ends or it is revoked.`,
							},
						],
					};
				});
			},
		});
	};

	const registerCommands = () => {
		pi.registerCommand("remote-admin-elevate", {
			description: "Approve an elevated root SSH session for remote-admin",
			handler: async (_args, ctx) => {
				const state = requireRemote();
				await ctx.waitForIdle();
				await runAndRefreshStatus(ctx, async () => {
					await state.elevation.approve(ctx, "next agent response");
					ctx.ui.notify(`Elevated remote session active for ${state.elevation.describe()}`, "info");
				});
			},
		});
		pi.registerCommand("remote-admin-revoke", {
			description: "Revoke the elevated remote-admin SSH session",
			handler: async (_args, ctx) => {
				const state = requireRemote();
				await state.elevation.revoke();
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
			remoteState = await createRemoteState(config, localCwd, ctx);
			setStatus(ctx);
			ctx.ui.notify(`Remote admin connected: ${remoteState.config.target}:${remoteState.config.cwd}`, "info");
			warnIfRtkExtensionLoaded(ctx);
		} catch (error) {
			remoteState = null;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("remote-admin", ctx.ui.theme.fg("warning", `Remote admin failed: ${config.target}`));
			ctx.ui.notify(`Remote admin failed: ${message}`, "warning");
		}
	});

	pi.on("agent_end", async () => {
		await remoteState?.elevation.revokeAgentResponse();
	});

	pi.on("session_shutdown", async () => {
		if (!remoteState) return;
		await remoteState.elevation.revoke();
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
