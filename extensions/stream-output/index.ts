import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ansi = {
	dim: "\x1b[90m",
	cyan: "\x1b[36m",
	yellow: "\x1b[33m",
	reset: "\x1b[0m",
};

function color(code: string, text: string): string {
	return process.stderr.isTTY ? `${code}${text}${ansi.reset}` : text;
}

function writeLine(text: string): void {
	process.stderr.write(`${text}\n`);
}

function isPrintMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "print";
}

function parseArgs(args: unknown): Record<string, unknown> | undefined {
	if (typeof args === "object" && args !== null) return args as Record<string, unknown>;
	if (typeof args !== "string") return undefined;

	try {
		const parsed: unknown = JSON.parse(args);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function formatToolArgs(toolName: string, args: unknown): string {
	const parsed = parseArgs(args);
	if (!parsed) return "";

	switch (toolName) {
		case "bash":
			return typeof parsed.command === "string" ? parsed.command : "";
		case "read":
		case "write":
			return typeof parsed.path === "string" ? parsed.path : "";
		case "edit": {
			const count = Array.isArray(parsed.edits) ? parsed.edits.length : 0;
			return `${String(parsed.path ?? "")} (${count} edit${count === 1 ? "" : "s"})`;
		}
		default:
			return Object.keys(parsed).join(", ");
	}
}

export default function streamOutput(pi: ExtensionAPI): void {
	let responseAnnounced = false;

	pi.on("agent_start", (_event, ctx) => {
		if (!isPrintMode(ctx)) return;
		responseAnnounced = false;
		writeLine(color(ansi.dim, "[pi] working…"));
	});

	pi.on("message_update", (event, ctx) => {
		if (!isPrintMode(ctx) || responseAnnounced) return;
		if (event.assistantMessageEvent?.type !== "text_start") return;

		responseAnnounced = true;
		writeLine(color(ansi.cyan, "[pi] responding…"));
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!isPrintMode(ctx)) return;
		responseAnnounced = false;

		const args = formatToolArgs(event.toolName, event.args);
		writeLine(color(ansi.yellow, `→ ${event.toolName}${args ? `: ${args}` : ""}`));
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!isPrintMode(ctx)) return;
		writeLine(color(ansi.dim, "[pi] done"));
	});
}
