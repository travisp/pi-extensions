import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { StateStore } from "../src/state-store.ts";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "herdr-state-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(root, { recursive: true, force: true });
	});
	await mkdir(cwd);
	return { root, agentDir, cwd, store: new StateStore(), statePath: join(agentDir, "pi-herdr-dev.json") };
}

test("concurrent stores merge fields, resolve project aliases, and clean up transaction files", async (t) => {
	const { root, agentDir, cwd, store, statePath } = await fixture(t);
	const alias = join(root, "alias");
	await symlink(cwd, alias);
	await Promise.all([
		store.update(cwd, { command: "npm run dev" }),
		new StateStore().update(alias, { toolEnabled: true }),
		new StateStore().update(cwd, { paneId: "w1:p2" }),
	]);
	assert.deepEqual(await store.get(alias), { command: "npm run dev", toolEnabled: true, paneId: "w1:p2" });
	await store.update(cwd, { paneId: undefined });
	assert.deepEqual(await store.get(cwd), { command: "npm run dev", toolEnabled: true });
	assert.equal((await stat(statePath)).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(agentDir), ["pi-herdr-dev.json"]);
});

test("concurrent remove and updates retain unrelated project state", async (t) => {
	const { root, cwd, store } = await fixture(t);
	const other = join(root, "other");
	await mkdir(other);
	await store.update(cwd, { command: "old" });
	await Promise.all([
		store.remove(cwd),
		store.update(other, { command: "new" }),
		store.update(other, { toolEnabled: true }),
	]);
	assert.equal(await store.get(cwd), undefined);
	assert.deepEqual(await store.get(other), { command: "new", toolEnabled: true });
});

test("a failed transaction releases its lock without overwriting invalid state", async (t) => {
	const { agentDir, cwd, store, statePath } = await fixture(t);
	await mkdir(agentDir);
	await writeFile(statePath, "invalid json");
	await assert.rejects(store.update(cwd, { command: "new" }), SyntaxError);
	assert.equal(await readFile(statePath, "utf8"), "invalid json");
	assert.deepEqual(await readdir(agentDir), ["pi-herdr-dev.json"]);
	await writeFile(statePath, "{}");
	await store.update(cwd, { command: "retry" });
	assert.deepEqual(await store.get(cwd), { command: "retry" });
});

test("lock timeout leaves the other writer's lock and state untouched", async (t) => {
	const { cwd, store, statePath } = await fixture(t);
	await store.update(cwd, { command: "original" });
	const original = await readFile(statePath, "utf8");
	await mkdir(`${statePath}.lock`);
	let now = 0;
	t.mock.method(Date, "now", () => { now += 6_000; return now; });
	await assert.rejects(store.update(cwd, { command: "replacement" }), /Timed out waiting for .*\.lock/);
	assert.ok((await stat(`${statePath}.lock`)).isDirectory());
	assert.equal(await readFile(statePath, "utf8"), original);
});

test("separate Pi processes do not lose same-project fields or other projects", { timeout: 15_000 }, async (t) => {
	const { root, cwd, store, statePath } = await fixture(t);
	const workers = [];
	for (let index = 0; index < 6; index++) {
		const ownProject = join(root, `project-${index}`);
		await mkdir(ownProject);
		const child = fork(new URL("./state-worker.mjs", import.meta.url), [cwd, ownProject, String(index)], { silent: true });
		t.after(() => child.kill());
		let stderr = "";
		child.stderr.on("data", (data) => { stderr += data; });
		const exited = once(child, "exit").then(([code]) => assert.equal(code, 0, stderr));
		workers.push({ child, ready: once(child, "message"), exited });
	}
	await Promise.all(workers.map((worker) => worker.ready));
	for (const { child } of workers) child.send("go");
	await Promise.all(workers.map((worker) => worker.exited));
	const state = JSON.parse(await readFile(statePath, "utf8"));
	assert.equal(Object.keys(state).length, 7);
	assert.deepEqual(await store.get(cwd), { command: "npm run dev", paneId: "w1:p2", toolEnabled: true });
	for (let index = 0; index < 6; index++) {
		assert.deepEqual(state[await realpath(join(root, `project-${index}`))], { command: `worker-${index}` });
	}
});
