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
 */

import { spawn } from "node:child_process";
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
import { Type } from "typebox";

type SshTmuxConfig = {
	remote: string;
	remoteCwd: string;
	session: string;
	target: string;
};

type RunResult = {
	output: Buffer;
	exitCode: number | null;
};

const DEFAULT_SESSION = "pi-ssh-tmux";
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

	constructor(private readonly config: SshTmuxConfig) {}

	async ensure(): Promise<void> {
		if (this.ready) return;

		const { remote, remoteCwd, session, target } = this.config;
		await sshExec(remote, "command -v tmux >/dev/null || { echo 'Remote requirement missing: tmux. Install tmux on the remote host.' >&2; exit 127; }");
		await sshExec(remote, "command -v bash >/dev/null || { echo 'Remote requirement missing: bash.' >&2; exit 127; }");
		await sshExec(remote, "command -v base64 >/dev/null || { echo 'Remote requirement missing: base64.' >&2; exit 127; }");
		await sshExec(remote, `mkdir -p ${shQuote(remoteCwd)}`);

		const create = [
			`tmux has-session -t ${shQuote(session)} 2>/dev/null`,
			"||",
			`tmux new-session -d -s ${shQuote(session)} -c ${shQuote(remoteCwd)} ${shQuote("bash --noprofile --norc")}`,
		].join(" ");
		await sshExec(remote, create);
		await sshExec(remote, `tmux set-option -t ${shQuote(session)} history-limit 200000 >/dev/null`);
		await sshExec(remote, `tmux resize-window -t ${shQuote(target)} -x 1000 -y 60 >/dev/null 2>&1 || true`);

		// Quiet the pane so pasted commands are not echoed into captured output.
		await this.pasteToPane(`stty -echo 2>/dev/null || true\nexport PS1='[pi-ssh-tmux]$ '\nprintf '[pi init] cwd=%s\\n' ${shQuote(remoteCwd)}\ncd ${shQuote(remoteCwd)}\n`);
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

		const auditedPaste = audit ? `printf '%s\\n' ${shQuote(audit)}\n${paste}` : paste;
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
		const { remote, target } = this.config;
		await sshExec(remote, `tmux load-buffer -b ${shQuote(bufferName)} -`, text);
		await sshExec(remote, `tmux paste-buffer -b ${shQuote(bufferName)} -t ${shQuote(target)} && tmux delete-buffer -b ${shQuote(bufferName)}`);
	}

	private async sendKeys(...keys: string[]): Promise<void> {
		const quoted = keys.map(shQuote).join(" ");
		await sshExec(this.config.remote, `tmux send-keys -t ${shQuote(this.config.target)} ${quoted}`);
	}

	private async capture(): Promise<Buffer> {
		return sshExec(this.config.remote, `tmux capture-pane -J -p -t ${shQuote(this.config.target)} -S -`);
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
			requireOk(await session.run(`p=${shQuote(remotePath)}\ntest -r "$p" || sudo -n test -r "$p"`, { audit: audit("access", remotePath) }), `access ${remotePath}`);
		},
		detectImageMimeType: async (p) => {
			const remotePath = toRemote(p);
			try {
				const out = requireOk(
					await session.run(`p=${shQuote(remotePath)}\nif test -r "$p"; then file --mime-type -b "$p"; else sudo -n file --mime-type -b "$p"; fi`, { audit: audit("mime", remotePath) }),
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
				await session.run(`p=${shQuote(remotePath)}\n{ test -r "$p" && test -w "$p"; } || { sudo -n test -r "$p" && sudo -n test -w "$p"; }`, { audit: audit("edit access", remotePath) }),
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
		exists: async (p) => (await session.run(`test -e ${shQuote(toRemote(p))}`, { audit: audit("exists", toRemote(p)) })).exitCode === 0,
		stat: async (p) => {
			const remotePath = toRemote(p);
			const result = await session.run(`test -d ${shQuote(remotePath)}`, { audit: audit("stat", remotePath) });
			if (result.exitCode === 0) return { isDirectory: () => true };
			const exists = await session.run(`test -e ${shQuote(remotePath)}`, { audit: audit("exists", remotePath) });
			if (exists.exitCode === 0) return { isDirectory: () => false };
			throw new Error(`Path not found: ${remotePath}`);
		},
		readdir: async (p) => {
			const remotePath = toRemote(p);
			const script = `python3 - <<'PY'\nimport os\nfor entry in os.listdir(${JSON.stringify(remotePath)}):\n    print(entry)\nPY`;
			return requireOk(await session.run(script, { audit: audit("ls", remotePath) }), `readdir ${remotePath}`).toString("utf8").split("\n").filter(Boolean);
		},
	};
}

function createRemoteFindOps(session: SshTmuxSession, remoteCwd: string, localCwd: string): FindOperations {
	const toRemote = createPathMapper(localCwd, remoteCwd);
	return {
		exists: async (p) => (await session.run(`test -e ${shQuote(toRemote(p))}`, { audit: audit("exists", toRemote(p)) })).exitCode === 0,
		glob: async (pattern, cwd, { limit }) => {
			const remoteSearchRoot = toRemote(cwd);
			const script = [
				`cd ${shQuote(remoteSearchRoot)}`,
				`if command -v rg >/dev/null 2>&1; then`,
				`  rg --files --hidden --glob ${shQuote(pattern)} --glob '!node_modules/**' --glob '!.git/**' | head -n ${Math.max(1, limit)}`,
				`else`,
				`  python3 - ${shQuote(pattern)} ${String(Math.max(1, limit))} <<'PY'`,
				`import fnmatch, os, sys`,
				`pat=sys.argv[1]; limit=int(sys.argv[2]); count=0`,
				`for root, dirs, files in os.walk('.'):` ,
				`    dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules')]`,
				`    for name in files:`,
				`        rel=os.path.join(root, name).lstrip('./')`,
				`        if fnmatch.fnmatch(rel, pat):`,
				`            print(rel); count += 1`,
				`            if count >= limit: sys.exit(0)`,
				`PY`,
				`fi`,
			].join("\n");
			const out = requireOk(await session.run(script, { audit: audit("find", `${pattern} in ${remoteSearchRoot}`) }), `find ${pattern}`).toString("utf8").trim();
			if (!out) return [];
			return out.split("\n").map((p) => path.posix.join(remoteSearchRoot, p));
		},
	};
}

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
	context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

function createRemoteGrepTool(session: SshTmuxSession, remoteCwd: string, localCwd: string) {
	const toRemote = createPathMapper(localCwd, remoteCwd);
	return {
		name: "grep",
		label: "grep",
		description: `Search remote file contents through the SSH tmux session. Returns matching lines with paths and line numbers. Output is truncated to 100 matches or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: "Search remote file contents for patterns through SSH tmux",
		parameters: grepSchema,
		async execute(_toolCallId, params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }, signal?: AbortSignal) {
			const searchPath = toRemote(path.resolve(localCwd, params.path || "."));
			const effectiveLimit = Math.max(1, params.limit ?? 100);
			const rgArgs = ["--line-number", "--color=never", "--hidden"];
			if (params.ignoreCase) rgArgs.push("--ignore-case");
			if (params.literal) rgArgs.push("--fixed-strings");
			if (params.context && params.context > 0) rgArgs.push("-C", String(Math.floor(params.context)));
			if (params.glob) rgArgs.push("--glob", params.glob);
			const quotedArgs = rgArgs.map(shQuote).join(" ");
			const script = [
				`if ! command -v rg >/dev/null 2>&1; then echo 'ripgrep (rg) is required on the remote for grep'; exit 127; fi`,
				`rg ${quotedArgs} -- ${shQuote(params.pattern)} ${shQuote(searchPath)} | head -n ${effectiveLimit + 1}`,
			].join("\n");
			const result = await session.run(script, { signal, audit: audit("grep", `${params.pattern} in ${searchPath}`) });
			// rg returns 1 for no matches, but the pipe exits with head's status. Treat any
			// emitted rg error text as normal command output so the model can see it.
			if (result.exitCode !== 0) throw new Error(result.output.toString("utf8") || `grep failed (${result.exitCode})`);
			let lines = result.output.toString("utf8").split("\n").filter(Boolean);
			const matchLimitReached = lines.length > effectiveLimit ? effectiveLimit : undefined;
			if (matchLimitReached) lines = lines.slice(0, effectiveLimit);
			if (lines.length === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
			const raw = lines.join("\n");
			const truncation = truncateHead(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
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
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh-tmux", { description: "SSH tmux remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localLs = createLsTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	let resolved: { config: SshTmuxConfig; session: SshTmuxSession } | null = null;

	const getRemote = () => resolved;

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate) {
			const remote = getRemote();
			if (!remote) return localRead.execute(id, params, signal, onUpdate);
			return createReadTool(localCwd, { operations: createRemoteReadOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate) {
			const remote = getRemote();
			if (!remote) return localWrite.execute(id, params, signal, onUpdate);
			return createWriteTool(localCwd, { operations: createRemoteWriteOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate) {
			const remote = getRemote();
			if (!remote) return localEdit.execute(id, params, signal, onUpdate);
			return createEditTool(localCwd, { operations: createRemoteEditOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate) {
			const remote = getRemote();
			if (!remote) return localBash.execute(id, params, signal, onUpdate);
			return createBashTool(localCwd, { operations: createRemoteBashOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate) {
			const remote = getRemote();
			if (!remote) return localLs.execute(id, params, signal, onUpdate);
			return createLsTool(localCwd, { operations: createRemoteLsOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate) {
			const remote = getRemote();
			if (!remote) return localFind.execute(id, params, signal, onUpdate);
			return createFindTool(localCwd, { operations: createRemoteFindOps(remote.session, remote.config.remoteCwd, localCwd) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...createRemoteGrepTool({} as SshTmuxSession, localCwd, localCwd),
		async execute(id, params, signal, onUpdate, ctx) {
			const remote = getRemote();
			if (!remote) return localGrep.execute(id, params, signal, onUpdate, ctx);
			return createRemoteGrepTool(remote.session, remote.config.remoteCwd, localCwd).execute(id, params as any, signal);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const arg = pi.getFlag("ssh-tmux") as string | undefined;
		if (!arg) return;

		const parsed = parseSshTmuxArg(arg);
		const remoteCwd = await resolveRemoteCwd(parsed.remote, parsed.remoteCwd);
		const config: SshTmuxConfig = {
			remote: parsed.remote,
			remoteCwd,
			session: DEFAULT_SESSION,
			// Target the active pane in the session. This avoids assuming tmux window/pane
			// base indexes are 0; user configs often set them to 1.
			target: DEFAULT_SESSION,
		};
		const session = new SshTmuxSession(config);
		await session.ensure();
		resolved = { config, session };

		ctx.ui.setStatus("ssh-tmux", ctx.ui.theme.fg("accent", `SSH tmux: ${config.remote}:${config.remoteCwd} (${config.session})`));
		ctx.ui.notify(`SSH tmux mode: ${config.remote}:${config.remoteCwd} (${config.session})`, "info");
	});

	pi.on("user_bash", () => {
		const remote = getRemote();
		if (!remote) return;
		return { operations: createRemoteBashOps(remote.session, remote.config.remoteCwd, localCwd) };
	});

	pi.on("before_agent_start", async (event) => {
		const remote = getRemote();
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
