/**
 * SSH tmux remote execution extension.
 *
 * Routes Pi's built-in coding tools through a persistent remote tmux pane over SSH.
 * This enables on-demand sudo approval by attaching to the same tmux session and
 * running `sudo -v`; subsequent agent commands can use `sudo -n` while the sudo
 * timestamp remains valid.
 *
 * Usage:
 *   pi -e ./pi-ssh-tmux --ssh-tmux user@host
 *   pi -e ./pi-ssh-tmux --ssh-tmux user@host:/remote/path
 *
 * Requirements on remote:
 *   - ssh key-based auth
 *   - tmux
 *   - bash
 *   - base64
 *   - find
 *   - ripgrep (rg) for grep/find tools
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "@mariozechner/pi-coding-agent";

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

const DEFAULT_SESSION = "pi-ssh-tmux";
const DEFAULT_SHELL_IDLE_TIMEOUT_SECONDS = 24 * 60 * 60;
const POLL_INTERVAL_MS = 120;

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

function parseNonNegativeInteger(value: unknown, defaultValue: number): number {
	if (value === undefined || value === null || value === "") return defaultValue;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
	return Math.floor(parsed);
}

function sshExec(remote: string, command: string, input?: Buffer | string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [remote, command], { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
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
	private humanEchoLikelyOn = false;

	constructor(private readonly config: SshTmuxConfig) {}

	isHumanEchoLikelyOn(): boolean {
		return this.humanEchoLikelyOn;
	}

	markHumanEchoLikelyOn(): void {
		this.humanEchoLikelyOn = true;
	}

	markNotReady(): void {
		this.ready = false;
		this.humanEchoLikelyOn = false;
	}

	async ensure(): Promise<void> {
		const { remote, remoteCwd, session, shellIdleTimeoutSeconds } = this.config;
		if (this.ready) {
			const hasSession = await sshExec(remote, `tmux has-session -t ${shQuote(session)} 2>/dev/null && echo yes || echo no`).catch(() => Buffer.from("no"));
			if (hasSession.toString().trim() === "yes") return;
			this.ready = false;
		}

		await sshExec(remote, "command -v tmux >/dev/null || { echo 'Remote requirement missing: tmux. Install tmux on the remote host.' >&2; exit 127; }");
		await sshExec(remote, "command -v bash >/dev/null || { echo 'Remote requirement missing: bash.' >&2; exit 127; }");
		await sshExec(remote, "command -v base64 >/dev/null || { echo 'Remote requirement missing: base64.' >&2; exit 127; }");
		await sshExec(remote, "command -v find >/dev/null || { echo 'Remote requirement missing: find.' >&2; exit 127; }");
		await sshExec(remote, "command -v rg >/dev/null || { echo 'Remote requirement missing: ripgrep (rg).' >&2; exit 127; }");
		await sshExec(remote, `mkdir -p ${shQuote(remoteCwd)}`);

		const create = [
			`tmux has-session -t ${shQuote(session)} 2>/dev/null`,
			"||",
			`tmux new-session -d -s ${shQuote(session)} -c ${shQuote(remoteCwd)} ${shQuote("bash --noprofile --norc")}`,
		].join(" ");
		await sshExec(remote, create);
		await sshExec(remote, `tmux set-option -t ${shQuote(session)} history-limit 200000 >/dev/null`);
		await sshExec(remote, `tmux resize-window -t ${shQuote(session)} -x 1000 -y 60 >/dev/null 2>&1 || true`);

		const timeoutSetup = shellIdleTimeoutSeconds > 0 ? `export TMOUT=${shellIdleTimeoutSeconds}` : "unset TMOUT";

		// Quiet the pane so pasted commands are not echoed into captured output.
		await this.pasteToPane(`stty -echo 2>/dev/null || true\nexport PS1='[pi-ssh-tmux]$ '\n${timeoutSetup}\nprintf '[pi init] cwd=%s shell_idle_timeout=%s\\n' ${shQuote(remoteCwd)} ${shQuote(String(shellIdleTimeoutSeconds))}\ncd ${shQuote(remoteCwd)}\n`);
		this.humanEchoLikelyOn = false;
		await sleep(150);
		this.ready = true;
	}

	async run(script: string, options: { signal?: AbortSignal; timeout?: number; onData?: (data: Buffer) => void; audit?: string } = {}): Promise<RunResult> {
		const runQueued = async () => this.runUnqueued(script, options);
		const result = this.queue.then(runQueued, runQueued);
		this.queue = result.catch(() => {});
		return result;
	}

	private async runUnqueued(
		script: string,
		{ signal, timeout, onData, audit }: { signal?: AbortSignal; timeout?: number; onData?: (data: Buffer) => void; audit?: string },
	): Promise<RunResult> {
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
		const quietPrefix = "stty -echo 2>/dev/null || true; printf '\\r\\033[K'\n";
		const auditedPaste = `${quietPrefix}${audit ? `printf '%s\\n' ${shQuote(audit)}\n` : ""}${paste}`;
		this.humanEchoLikelyOn = false;
		await this.pasteToPane(auditedPaste);

		let lastStreamed = 0;
		const started = Date.now();
		let abortRequested = false;
		const onAbort = () => {
			abortRequested = true;
			void this.sendKeys("C-c").catch(() => {});
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			while (true) {
				if (abortRequested || signal?.aborted) return { output: Buffer.alloc(0), exitCode: null };
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
						const endLine = captured.slice(endIndex).split("\n", 1)[0] ?? "";
						const match = endLine.match(new RegExp(`^${end.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:(-?\\d+)`));
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

function requireOk(result: RunResult, action: string): Buffer {
	if (result.exitCode !== 0) {
		const output = result.output.toString("utf8").trim();
		throw new Error(`${action} failed${result.exitCode === null ? "" : ` (${result.exitCode})`}${output ? `: ${output}` : ""}`);
	}
	return result.output;
}

function createRemoteReadOps(session: SshTmuxSession, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = createPathMapper(localCwd, remoteCwd);
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
			try {
				const out = requireOk(
					await session.run(`p=${shQuote(remotePath)}\nif test -r "$p"; then file --mime-type -b "$p"; else sudo -n file --mime-type -b "$p"; fi`),
					`mime ${remotePath}`,
				)
					.toString("utf8")
					.trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(out) ? out : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(session: SshTmuxSession, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = createPathMapper(localCwd, remoteCwd);
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

function createRemoteEditOps(session: SshTmuxSession, remoteCwd: string, localCwd: string): EditOperations {
	const read = createRemoteReadOps(session, remoteCwd, localCwd);
	const write = createRemoteWriteOps(session, remoteCwd, localCwd);
	const toRemote = createPathMapper(localCwd, remoteCwd);
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

function createRemoteBashOps(session: SshTmuxSession, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = createPathMapper(localCwd, remoteCwd);
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const remoteCwdForCommand = toRemote(cwd);
			const script = `cd ${shQuote(remoteCwdForCommand)} && {\n${command}\n}`;
			const result = await session.run(script, { onData, signal, timeout, audit: audit("bash", command) });
			return { exitCode: result.exitCode };
		},
	};
}

function createRemoteLsOps(session: SshTmuxSession, remoteCwd: string, localCwd: string): LsOperations {
	const toRemote = createPathMapper(localCwd, remoteCwd);
	return {
		exists: async (p) => (await session.run(`test -e ${shQuote(toRemote(p))}`)).exitCode === 0,
		stat: async (p) => {
			const remotePath = toRemote(p);
			const result = await session.run(`test -d ${shQuote(remotePath)}`);
			if (result.exitCode === 0) return { isDirectory: () => true };
			const exists = await session.run(`test -e ${shQuote(remotePath)}`);
			if (exists.exitCode === 0) return { isDirectory: () => false };
			throw new Error(`Path not found: ${remotePath}`);
		},
		readdir: async (p) => {
			const remotePath = toRemote(p);
			const script = `find ${shQuote(remotePath)} -mindepth 1 -maxdepth 1 -printf '%f\\n'`;
			return requireOk(await session.run(script, { audit: audit("ls", remotePath) }), `readdir ${remotePath}`).toString("utf8").split("\n").filter(Boolean);
		},
	};
}

function createRemoteFindOps(session: SshTmuxSession, remoteCwd: string, localCwd: string): FindOperations {
	const toRemote = createPathMapper(localCwd, remoteCwd);
	return {
		exists: async (p) => (await session.run(`test -e ${shQuote(toRemote(p))}`)).exitCode === 0,
		glob: async (pattern, cwd, { limit }) => {
			const remoteSearchRoot = toRemote(cwd);
			const script = [
				`cd ${shQuote(remoteSearchRoot)}`,
				`rg --files --hidden --glob ${shQuote(pattern)} --glob '!node_modules/**' --glob '!.git/**' | head -n ${Math.max(1, limit)}`,
			].join("\n");
			const out = requireOk(await session.run(script, { audit: audit("find", `${pattern} in ${remoteSearchRoot}`) }), `find ${pattern}`).toString("utf8").trim();
			if (!out) return [];
			return out.split("\n").map((p) => path.posix.join(remoteSearchRoot, p));
		},
	};
}

type RemoteGrepParams = {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
};

async function runRemoteGrep(session: SshTmuxSession, remoteCwd: string, localCwd: string, params: RemoteGrepParams, signal?: AbortSignal) {
	const toRemote = createPathMapper(localCwd, remoteCwd);
	const searchPath = toRemote(path.resolve(localCwd, params.path || "."));
	const effectiveLimit = Math.max(1, params.limit ?? 100);
	const rgArgs = ["--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase) rgArgs.push("--ignore-case");
	if (params.literal) rgArgs.push("--fixed-strings");
	if (params.context && params.context > 0) rgArgs.push("-C", String(Math.floor(params.context)));
	if (params.glob) rgArgs.push("--glob", params.glob);

	const script = [
		`tmp=$(mktemp)`,
		`rg ${rgArgs.map(shQuote).join(" ")} -- ${shQuote(params.pattern)} ${shQuote(searchPath)} > "$tmp"`,
		`rc=$?`,
		`if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; then cat "$tmp"; rm -f "$tmp"; exit "$rc"; fi`,
		`head -n ${effectiveLimit + 1} "$tmp"`,
		`rm -f "$tmp"`,
	].join("\n");
	const result = await session.run(script, { signal, audit: audit("grep", `${params.pattern} in ${searchPath}`) });
	if (result.exitCode !== 0) throw new Error(result.output.toString("utf8") || `grep failed (${result.exitCode})`);

	let lines = result.output.toString("utf8").split("\n").filter(Boolean);
	const matchLimitReached = lines.length > effectiveLimit ? effectiveLimit : undefined;
	if (matchLimitReached) lines = lines.slice(0, effectiveLimit);
	if (lines.length === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };

	const truncation = truncateHead(lines.join("\n"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let text = truncation.content;
	const notices: string[] = [];
	const details: { truncation?: unknown; matchLimitReached?: number } = {};
	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached`);
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length) text += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text" as const, text }], details: Object.keys(details).length ? details : undefined };
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh-tmux", { description: "SSH tmux remote: user@host or user@host:/path", type: "string" });
	pi.registerFlag("ssh-tmux-shell-timeout", {
		description: "Seconds of idle shell time before the remote tmux shell exits (default: 86400, 0 disables)",
		type: "string",
	});

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localLs = createLsTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	let resolved: { config: SshTmuxConfig; session: SshTmuxSession } | null = null;

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate) {
			const remote = resolved;
			if (!remote) return localRead.execute(id, params, signal, onUpdate);
			return createReadTool(localCwd, { operations: createRemoteReadOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate) {
			const remote = resolved;
			if (!remote) return localWrite.execute(id, params, signal, onUpdate);
			return createWriteTool(localCwd, { operations: createRemoteWriteOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate) {
			const remote = resolved;
			if (!remote) return localEdit.execute(id, params, signal, onUpdate);
			return createEditTool(localCwd, { operations: createRemoteEditOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate) {
			const remote = resolved;
			if (!remote) return localBash.execute(id, params, signal, onUpdate);
			return createBashTool(localCwd, { operations: createRemoteBashOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate) {
			const remote = resolved;
			if (!remote) return localLs.execute(id, params, signal, onUpdate);
			return createLsTool(localCwd, { operations: createRemoteLsOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate) {
			const remote = resolved;
			if (!remote) return localFind.execute(id, params, signal, onUpdate);
			return createFindTool(localCwd, { operations: createRemoteFindOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(id, params, signal, onUpdate, ctx) {
			const remote = resolved;
			if (!remote) return localGrep.execute(id, params, signal, onUpdate, ctx);
			return runRemoteGrep(remote.session, remote.config.remoteCwd, localCwd, params as RemoteGrepParams, signal);
		},
	});

	pi.registerCommand("ssh-tmux-attach", {
		description: "Suspend Pi and attach this terminal to the remote SSH tmux session",
		handler: async (_args, ctx) => {
			const remote = resolved;
			if (!remote) {
				ctx.ui.notify("No --ssh-tmux session is active", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/ssh-tmux-attach requires interactive mode", "warning");
				return;
			}

			await ctx.waitForIdle();
			await remote.session.ensure();

			const { config } = remote;
			const sendTmuxCommand = (command: string) =>
				sshExec(config.remote, `tmux send-keys -t ${shQuote(config.session)} ${shQuote(command)} C-m`);

			// Make the pane feel normal while the user is attached. We intentionally leave
			// echo enabled after detach; the next Pi tool execution turns it off before
			// pasting internal payloads. This avoids the visible post-detach `stty -echo`
			// command and stops the attach flow from fighting tmux/shell state.
			if (!remote.session.isHumanEchoLikelyOn()) {
				await sendTmuxCommand("stty echo 2>/dev/null || true; export PS1='[pi-ssh-tmux]$ '").catch(() => {});
				await sleep(150);
			}

			const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
				tui.stop();
				process.stdout.write("\x1b[2J\x1b[H");
				process.stdout.write(`Attaching to ${config.remote} tmux session ${config.session}. Detach with Ctrl-b then d (not Ctrl-d).\n\n`);
				const result = spawnSync("ssh", ["-tt", config.remote, `tmux attach -t ${shQuote(config.session)}`], {
					stdio: "inherit",
					env: process.env,
				});
				tui.start();
				tui.requestRender(true);
				done(result.status);
				return { render: () => [], invalidate: () => {} };
			});

			remote.session.markHumanEchoLikelyOn();

			if (exitCode === 0) ctx.ui.notify("Returned from SSH tmux session", "info");
			else ctx.ui.notify(`SSH tmux attach exited with code ${exitCode ?? "unknown"}`, "warning");
		},
	});

	pi.registerCommand("ssh-tmux-kill", {
		description: "Kill the remote SSH tmux session used by this extension",
		handler: async (_args, ctx) => {
			const remote = resolved;
			if (!remote) {
				ctx.ui.notify("No --ssh-tmux session is active", "warning");
				return;
			}

			await ctx.waitForIdle();
			const { config } = remote;
			await sshExec(config.remote, `tmux kill-session -t ${shQuote(config.session)} 2>/dev/null || true`);
			remote.session.markNotReady();
			ctx.ui.notify(`Killed SSH tmux session ${config.session} on ${config.remote}`, "info");
			ctx.ui.setStatus("ssh-tmux", ctx.ui.theme.fg("warning", `SSH tmux killed: ${config.remote}:${config.remoteCwd}`));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const arg = pi.getFlag("ssh-tmux") as string | undefined;
		if (!arg) return;

		const parsed = parseSshTmuxArg(arg);
		const remoteCwd = await resolveRemoteCwd(parsed.remote, parsed.remoteCwd);
		const shellIdleTimeoutSeconds = parseNonNegativeInteger(pi.getFlag("ssh-tmux-shell-timeout"), DEFAULT_SHELL_IDLE_TIMEOUT_SECONDS);
		const config: SshTmuxConfig = {
			remote: parsed.remote,
			remoteCwd,
			session: DEFAULT_SESSION,
			shellIdleTimeoutSeconds,
		};
		const session = new SshTmuxSession(config);
		await session.ensure();
		resolved = { config, session };

		ctx.ui.setStatus("ssh-tmux", ctx.ui.theme.fg("accent", `SSH tmux: ${config.remote}:${config.remoteCwd} (${config.session})`));
		ctx.ui.notify(`SSH tmux mode: ${config.remote}:${config.remoteCwd} (${config.session})`, "info");
	});

	pi.on("user_bash", () => {
		const remote = resolved;
		if (!remote) return;
		return { operations: createRemoteBashOps(remote.session, remote.config.remoteCwd, localCwd) };
	});

	pi.on("before_agent_start", async (event) => {
		const remote = resolved;
		if (!remote) return;
		const { config } = remote;
		const sudoHint = [
			"Remote execution is running through a persistent SSH tmux session.",
			`Current working directory: ${config.remoteCwd} (via SSH tmux: ${config.remote}, session ${config.session})`,
			"If privileged access is needed, use `sudo -n` so commands fail instead of prompting.",
			"The user can unlock sudo outside Pi by attaching to the same tmux session, running `sudo -v`, then detaching.",
		].join("\n");
		const modified = event.systemPrompt.replace(`Current working directory: ${localCwd}`, sudoHint);
		return { systemPrompt: modified };
	});
}
