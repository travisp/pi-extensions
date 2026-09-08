import { StateStore } from "./state-store.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_LOG_LINES,
	MAX_LOG_LINES,
	inferDevCommand,
	parseDevRoute,
	parsePaneRunning,
	parseTabPaneId,
	type DevRoute,
} from "./core.ts";

const HERDR_TIMEOUT_MS = 8_000;
const MAX_LOG_BYTES = 40_000;
const DEV_TOOL_NAME = "dev_server";
const DEV_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["status", "logs", "start", "stop", "restart"] },
		command: { type: "string", description: "Command override for start or restart" },
		lines: { type: "integer", minimum: 1, maximum: MAX_LOG_LINES },
	},
	required: ["action"],
	additionalProperties: false,
} as const;

type DevToolParameters = {
	action: "status" | "logs" | "start" | "stop" | "restart";
	command?: string;
	lines?: number;
};

const HELP_TEXT = `/dev start [command]   Start the inferred or supplied command
/dev status            Show server status
/dev logs [lines]      Show recent output (default ${DEFAULT_LOG_LINES}, max ${MAX_LOG_LINES})
/dev restart [command] Restart using the remembered command, or this command
/dev stop              Stop the server and close its pane
/dev tool on|off       Enable or disable the agent tool for this project
/dev forget            Stop and remove this project's saved state
/dev help              Show this help`;

const DEV_COMMAND_COMPLETIONS = [
	{ value: "status", label: "status", description: "Show server status" },
	{ value: "start", label: "start [command]", description: "Start the inferred or supplied command" },
	{ value: "logs", label: "logs [lines]", description: "Show recent server output" },
	{ value: "restart", label: "restart [command]", description: "Restart the server" },
	{ value: "stop", label: "stop", description: "Stop the server and close its pane" },
	{ value: "tool", label: "tool on|off", description: "Control agent access for this project" },
	{ value: "forget", label: "forget", description: "Stop and remove this project's saved state" },
	{ value: "help", label: "help", description: "Show command help" },
];

const DEV_TOOL_COMPLETIONS = [
	{ value: "tool on", label: "tool on", description: "Enable the dev_server agent tool" },
	{ value: "tool off", label: "tool off", description: "Disable the dev_server agent tool" },
];

type DevStatus = {
	state: "running" | "idle" | "stopped";
	command?: string;
	paneId?: string;
};

type RouteResult = {
	text: string;
	status?: DevStatus;
};

function trimLogOutput(output: string): string {
	if (Buffer.byteLength(output) <= MAX_LOG_BYTES) return output.trimEnd();
	const tail = Buffer.from(output).subarray(-MAX_LOG_BYTES).toString();
	return `[Earlier output omitted]\n${tail}`.trimEnd();
}

class DevServerManager {
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly store: StateStore,
	) {}

	private async herdr(args: string[]): Promise<string> {
		const result = await this.pi.exec("herdr", args, { timeout: HERDR_TIMEOUT_MS });
		if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Herdr command failed");
		return result.stdout;
	}

	async status(cwd: string): Promise<DevStatus> {
		const project = await this.store.get(cwd);
		const command = project?.command ?? (await inferDevCommand(cwd));
		if (!project?.paneId) return { state: "stopped", command };

		const result = await this.pi.exec(
			"herdr",
			["pane", "process-info", "--pane", project.paneId],
			{ timeout: HERDR_TIMEOUT_MS },
		);
		if (result.code !== 0) {
			await this.store.update(cwd, { paneId: undefined });
			return { state: "stopped", command };
		}

		return {
			state: parsePaneRunning(result.stdout) ? "running" : "idle",
			command,
			paneId: project.paneId,
		};
	}

	async isToolEnabled(cwd: string): Promise<boolean> {
		return (await this.store.get(cwd))?.toolEnabled === true;
	}

	async setToolEnabled(cwd: string, enabled: boolean): Promise<void> {
		await this.store.update(cwd, { toolEnabled: enabled });
	}

	async start(cwd: string, explicitCommand?: string): Promise<DevStatus> {
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		if (!workspaceId) throw new Error("/dev start requires Pi to be running in a Herdr-managed pane");

		const current = await this.status(cwd);
		if (current.state === "running") return current;

		const command = explicitCommand?.trim() || current.command;
		if (!command) throw new Error("Could not infer a dev command. Run /dev start <command> once for this project.");

		let paneId = current.paneId;
		if (!paneId) {
			const tab = await this.herdr([
				"tab",
				"create",
				"--workspace",
				workspaceId,
				"--cwd",
				cwd,
				"--label",
				"server",
				"--no-focus",
			]);
			paneId = parseTabPaneId(tab);
		}

		await this.herdr(["pane", "run", paneId, command]);
		await this.store.update(cwd, { command, paneId });
		return { state: "running", command, paneId };
	}

	async stop(cwd: string): Promise<DevStatus> {
		const current = await this.status(cwd);
		if (!current.paneId) return current;

		await this.herdr(["pane", "close", current.paneId]);
		await this.store.update(cwd, { paneId: undefined });
		return { state: "stopped", command: current.command };
	}

	async restart(cwd: string, command?: string): Promise<DevStatus> {
		await this.stop(cwd);
		return this.start(cwd, command);
	}

	async forget(cwd: string): Promise<DevStatus> {
		await this.stop(cwd);
		await this.store.remove(cwd);
		return { state: "stopped" };
	}

	async logs(cwd: string, lines: number): Promise<{ status: DevStatus; output: string }> {
		const status = await this.status(cwd);
		if (!status.paneId) return { status, output: "No managed dev pane exists for this project." };

		const output = await this.herdr([
			"pane",
			"read",
			status.paneId,
			"--source",
			"recent-unwrapped",
			"--lines",
			String(lines),
		]);
		return { status, output: trimLogOutput(output) };
	}
}

function formatStatus(status: DevStatus): string {
	const labels = {
		running: "running",
		idle: "not running (pane retained for logs)",
		stopped: "stopped",
	};
	const lines = [`Dev server: ${labels[status.state]}`];
	if (status.command) lines.push(`Command: ${status.command}`);
	if (status.paneId) lines.push(`Pane: ${status.paneId}`);
	return lines.join("\n");
}

function updateUiStatus(ctx: ExtensionContext, status: DevStatus): void {
	const text = status.state === "running" ? "dev: running" : status.state === "idle" ? "dev: exited" : undefined;
	ctx.ui.setStatus("herdr-dev", text);
}

async function runRoute(manager: DevServerManager, cwd: string, route: DevRoute): Promise<RouteResult> {
	switch (route.action) {
		case "help":
			return { text: HELP_TEXT };
		case "status": {
			const status = await manager.status(cwd);
			return { text: formatStatus(status), status };
		}
		case "start": {
			const status = await manager.start(cwd, route.command);
			return { text: formatStatus(status), status };
		}
		case "restart": {
			const status = await manager.restart(cwd, route.command);
			return { text: formatStatus(status), status };
		}
		case "stop": {
			const status = await manager.stop(cwd);
			return { text: formatStatus(status), status };
		}
		case "forget": {
			const status = await manager.forget(cwd);
			return { text: "Forgot this project. The dev_server tool is now disabled.", status };
		}
		case "logs": {
			const { status, output } = await manager.logs(cwd, route.lines);
			return { text: `${formatStatus(status)}\n\nRecent output:\n${output}`, status };
		}
		case "tool": {
			await manager.setToolEnabled(cwd, route.enabled);
			return {
				text: `dev_server tool: ${route.enabled ? "enabled" : "disabled"}`,
				status: await manager.status(cwd),
			};
		}
	}
}

export default function piHerdrDev(pi: ExtensionAPI): void {
	const manager = new DevServerManager(pi, new StateStore());
	let toolRegistered = false;

	function registerDevTool(): void {
		if (toolRegistered) return;

		pi.registerTool({
			name: DEV_TOOL_NAME,
			label: "Dev Server",
			description:
				"Inspect or manage the current project's development server in a Herdr tab. Status and logs are safe to inspect. Only start, stop, or restart when the user asks or when required to test the requested work.",
			promptSnippet: "Inspect or manage the project's dev server and read its Herdr pane logs",
			promptGuidelines: [
				"Use dev_server status or logs instead of starting a duplicate development server with bash.",
				"Only use dev_server start, stop, or restart when the user asks or when it is required to test the requested work.",
			],
			// Pi accepts plain JSON Schema and performs validation before execute().
			parameters: DEV_TOOL_PARAMETERS as any,
			async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
				const params = rawParams as DevToolParameters;
				let route: DevRoute;
				switch (params.action) {
					case "logs":
						route = { action: "logs", lines: params.lines ?? DEFAULT_LOG_LINES };
						break;
					case "start":
					case "restart":
						route = { action: params.action, command: params.command?.trim() || undefined };
						break;
					default:
						route = { action: params.action };
				}
				const result = await runRoute(manager, ctx.cwd, route);
				if (result.status) updateUiStatus(ctx, result.status);
				return {
					content: [{ type: "text", text: result.text }],
					details: result.status,
				};
			},
		});
		toolRegistered = true;
	}

	function enableDevTool(): void {
		registerDevTool();
		const activeTools = pi.getActiveTools();
		if (!activeTools.includes(DEV_TOOL_NAME)) pi.setActiveTools([...activeTools, DEV_TOOL_NAME]);
	}

	function disableDevTool(): void {
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== DEV_TOOL_NAME));
	}

	pi.registerCommand("dev", {
		description: "[start|stop|restart|status|logs|tool|forget|help] — Manage a dev server in a Herdr tab",
		getArgumentCompletions(prefix) {
			if (prefix.startsWith("tool ")) {
				return DEV_TOOL_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
			}
			if (prefix.includes(" ")) return null;
			return DEV_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix.trim()));
		},
		async handler(args, ctx) {
			try {
				const route = parseDevRoute(args);
				const result = await runRoute(manager, ctx.cwd, route);
				if (route.action === "tool") {
					if (route.enabled) enableDevTool();
					else disableDevTool();
				}
				if (route.action === "forget") disableDevTool();
				if (result.status) updateUiStatus(ctx, result.status);
				ctx.ui.notify(result.text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (await manager.isToolEnabled(ctx.cwd)) registerDevTool();
		updateUiStatus(ctx, await manager.status(ctx.cwd));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const status = await manager.status(ctx.cwd);
		updateUiStatus(ctx, status);
		if (!status.paneId) return;

		const toolEnabled = await manager.isToolEnabled(ctx.cwd);
		let context: string;
		if (status.state === "running") {
			context = `A development server is already running in Herdr pane ${status.paneId} with command ${JSON.stringify(status.command)}. Do not start a duplicate.`;
			if (toolEnabled) context += " Use dev_server to inspect status or logs.";
		} else {
			context = `The managed development-server pane ${status.paneId} is idle, so its previous command likely exited.`;
			if (toolEnabled) context += " Use dev_server logs to inspect the failure before restarting it.";
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
	});
}
