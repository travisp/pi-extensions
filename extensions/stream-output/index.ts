import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_STREAMED_TOOL_CHARS = 12_000;
const MAX_FINAL_TOOL_CHARS = 2_000;

const ansi = {
	dim: "\x1b[90m",
	cyan: "\x1b[36m",
	yellow: "\x1b[33m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	reset: "\x1b[0m",
};

function color(code: string, text: string): string {
	return process.stderr.isTTY ? `${code}${text}${ansi.reset}` : text;
}

function writeLine(text = ""): void {
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

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null) return "";

	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";

	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function truncate(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… output truncated`;
}

type ToolStream = {
	lastText: string;
	emittedChars: number;
	endsWithNewline: boolean;
	truncated: boolean;
};

export default function streamOutput(pi: ExtensionAPI): void {
	const toolStreams = new Map<string, ToolStream>();
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
		toolStreams.set(event.toolCallId, {
			lastText: "",
			emittedChars: 0,
			endsWithNewline: true,
			truncated: false,
		});

		const args = formatToolArgs(event.toolName, event.args);
		writeLine(color(ansi.yellow, `→ ${event.toolName}${args ? `: ${args}` : ""}`));
	});

	pi.on("tool_execution_update", (event, ctx) => {
		if (!isPrintMode(ctx)) return;
		const state = toolStreams.get(event.toolCallId);
		if (!state || state.truncated) return;

		const current = extractText(event.partialResult);
		if (!current) return;

		const delta = current.startsWith(state.lastText) ? current.slice(state.lastText.length) : current;
		state.lastText = current;
		if (!delta) return;

		const remaining = MAX_STREAMED_TOOL_CHARS - state.emittedChars;
		const chunk = delta.slice(0, remaining);
		if (chunk) {
			process.stderr.write(chunk);
			state.emittedChars += chunk.length;
			state.endsWithNewline = chunk.endsWith("\n");
		}

		if (delta.length > remaining) {
			if (!state.endsWithNewline) writeLine();
			writeLine(color(ansi.dim, "… tool output truncated"));
			state.endsWithNewline = true;
			state.truncated = true;
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!isPrintMode(ctx)) return;
		const state = toolStreams.get(event.toolCallId);
		toolStreams.delete(event.toolCallId);

		if (state?.emittedChars) {
			if (!state.endsWithNewline) writeLine();
		} else {
			const result = truncate(extractText(event.result), MAX_FINAL_TOOL_CHARS);
			if (result) writeLine(result);
		}

		const marker = event.isError ? "✗" : "✓";
		const markerColor = event.isError ? ansi.red : ansi.green;
		writeLine(color(markerColor, `${marker} ${event.toolName}`));
		writeLine();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!isPrintMode(ctx)) return;
		writeLine(color(ansi.dim, "[pi] done"));
	});
}
