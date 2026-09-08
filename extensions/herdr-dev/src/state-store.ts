import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type ProjectState = {
	command?: string;
	paneId?: string;
	toolEnabled?: boolean;
};

type StateFile = Record<string, ProjectState>;

export class StateStore {
	private readonly path: string;

	constructor() {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		this.path = join(agentDir, "pi-herdr-dev.json");
	}

	private async load(): Promise<StateFile> {
		try {
			return JSON.parse(await readFile(this.path, "utf8")) as StateFile;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	private async mutate(change: (state: StateFile) => void): Promise<void> {
		const lockPath = `${this.path}.lock`;
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + 5_000;
		// An atomic directory lock covers the whole transaction across Pi processes.
		while (true) {
			try {
				await mkdir(lockPath, { mode: 0o700 });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (Date.now() >= deadline) {
					throw new Error(`Timed out waiting for ${lockPath}. If a writer crashed, stop other Pi sessions before removing this lock directory.`);
				}
				await delay(25);
			}
		}

		// The lock owns the temporary file, so both share one cleanup path.
		const temporaryPath = join(lockPath, "state.json");
		try {
			const state = await this.load();
			change(state);
			await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
			await rename(temporaryPath, this.path);
		} finally {
			await rm(lockPath, { recursive: true });
		}
	}

	async get(cwd: string): Promise<ProjectState | undefined> {
		return (await this.load())[await realpath(cwd)];
	}

	async update(cwd: string, changes: ProjectState): Promise<void> {
		const key = await realpath(cwd);
		await this.mutate((state) => {
			state[key] = { ...state[key], ...changes };
		});
	}

	async remove(cwd: string): Promise<void> {
		const key = await realpath(cwd);
		await this.mutate((state) => {
			delete state[key];
		});
	}
}
