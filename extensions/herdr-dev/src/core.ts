import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_LOG_LINES = 80;
export const MAX_LOG_LINES = 200;

export type DevRoute =
	| { action: "status" | "stop" | "forget" | "help" }
	| { action: "start" | "restart"; command?: string }
	| { action: "logs"; lines: number }
	| { action: "tool"; enabled: boolean };

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

function packageManagerCommand(manager: string, script: "dev" | "start"): string {
	if (manager === "yarn") return `yarn ${script}`;
	if (manager === "pnpm") return `pnpm ${script}`;
	if (manager === "bun") return `bun run ${script}`;
	return script === "start" ? "npm start" : "npm run dev";
}

async function detectPackageManager(cwd: string, declared?: string): Promise<string> {
	const declaredName = declared?.split("@", 1)[0];
	if (declaredName && ["npm", "pnpm", "yarn", "bun"].includes(declaredName)) return declaredName;
	if (await exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (await exists(join(cwd, "yarn.lock"))) return "yarn";
	if ((await exists(join(cwd, "bun.lock"))) || (await exists(join(cwd, "bun.lockb")))) return "bun";
	return "npm";
}

export async function inferDevCommand(cwd: string): Promise<string | undefined> {
	if (await exists(join(cwd, "bin", "dev"))) return "bin/dev";

	const packagePath = join(cwd, "package.json");
	if (await exists(packagePath)) {
		const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
			packageManager?: string;
			scripts?: Record<string, string>;
		};
		const manager = await detectPackageManager(cwd, pkg.packageManager);
		if (pkg.scripts?.dev) return packageManagerCommand(manager, "dev");
		if (pkg.scripts?.start) return packageManagerCommand(manager, "start");
	}

	if ((await exists(join(cwd, "Gemfile"))) && (await exists(join(cwd, "bin", "rails")))) {
		return "bin/rails server";
	}
}

export function parseDevRoute(input: string): DevRoute {
	const [action = "status", ...words] = input.trim().split(/\s+/).filter(Boolean);
	const rest = words.join(" ");

	switch (action) {
		case "status":
		case "stop":
		case "forget":
		case "help":
			if (rest) throw new Error(`/dev ${action} does not accept arguments`);
			return { action };
		case "start":
		case "restart":
			return { action, command: rest || undefined };
		case "logs": {
			if (!rest) return { action, lines: DEFAULT_LOG_LINES };
			const lines = Number(rest);
			if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) {
				throw new Error(`Log lines must be between 1 and ${MAX_LOG_LINES}`);
			}
			return { action, lines };
		}
		case "tool":
			if (rest === "on") return { action, enabled: true };
			if (rest === "off") return { action, enabled: false };
			throw new Error("Usage: /dev tool on|off");
		default:
			throw new Error(`Unknown /dev action: ${action}`);
	}
}

type TabResponse = { result: { root_pane: { pane_id: string } } };
type ProcessResponse = {
	result: { process_info: { foreground_process_group_id: number; shell_pid: number } };
};

export function parseTabPaneId(stdout: string): string {
	return (JSON.parse(stdout) as TabResponse).result.root_pane.pane_id;
}

export function parsePaneRunning(stdout: string): boolean {
	const info = (JSON.parse(stdout) as ProcessResponse).result.process_info;
	return info.foreground_process_group_id !== info.shell_pid;
}
