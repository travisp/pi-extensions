import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	inferDevCommand,
	parseDevRoute,
	parsePaneRunning,
	parseTabPaneId,
} from "../src/core.ts";

async function project() {
	return mkdtemp(join(tmpdir(), "pi-herdr-dev-"));
}

test("parses command routes", () => {
	assert.deepEqual(parseDevRoute(""), { action: "status" });
	assert.deepEqual(parseDevRoute("start npm run web"), {
		action: "start",
		command: "npm run web",
	});
	assert.deepEqual(parseDevRoute("logs 25"), { action: "logs", lines: 25 });
	assert.deepEqual(parseDevRoute("forget"), { action: "forget" });
	assert.deepEqual(parseDevRoute("tool on"), { action: "tool", enabled: true });
	assert.deepEqual(parseDevRoute("tool off"), { action: "tool", enabled: false });
	assert.throws(() => parseDevRoute("tool maybe"), /tool on\|off/);
	assert.throws(() => parseDevRoute("logs 201"), /between 1 and 200/);
	assert.throws(() => parseDevRoute("wat"), /Unknown/);
});

test("prefers bin/dev", async () => {
	const cwd = await project();
	await mkdir(join(cwd, "bin"));
	await writeFile(join(cwd, "bin", "dev"), "#!/bin/sh\n");
	await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
	assert.equal(await inferDevCommand(cwd), "bin/dev");
});

test("infers Node package manager and dev script", async () => {
	const cwd = await project();
	await writeFile(
		join(cwd, "package.json"),
		JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { dev: "vite" } }),
	);
	assert.equal(await inferDevCommand(cwd), "pnpm dev");
});

test("falls back to the Node start script", async () => {
	const cwd = await project();
	await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { start: "next start" } }));
	assert.equal(await inferDevCommand(cwd), "npm start");
});

test("infers Rails server", async () => {
	const cwd = await project();
	await mkdir(join(cwd, "bin"));
	await writeFile(join(cwd, "Gemfile"), "gem 'rails'\n");
	await writeFile(join(cwd, "bin", "rails"), "#!/usr/bin/env ruby\n");
	assert.equal(await inferDevCommand(cwd), "bin/rails server");
});

test("parses Herdr responses", () => {
	assert.equal(
		parseTabPaneId(JSON.stringify({ result: { root_pane: { pane_id: "w1:p2" } } })),
		"w1:p2",
	);
	assert.equal(
		parsePaneRunning(
			JSON.stringify({
				result: {
					process_info: { foreground_process_group_id: 20, shell_pid: 10 },
				},
			}),
		),
		true,
	);
	assert.equal(
		parsePaneRunning(
			JSON.stringify({
				result: {
					process_info: { foreground_process_group_id: 10, shell_pid: 10 },
				},
			}),
		),
		false,
	);
});
