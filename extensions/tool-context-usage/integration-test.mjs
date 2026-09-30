import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The entry override tests installed or bundled Pi without installing dependencies.
const directory = await mkdtemp(join(tmpdir(), "pi-context-render-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
const configPath = join(directory, "extensions", "tool-context-usage.json");
const extensionPath = fileURLToPath(new URL("index.ts", import.meta.url));
const collapsePath = fileURLToPath(new URL("../codemode-collapse-fix/index.ts", import.meta.url));
const fixturePath = fileURLToPath(new URL("test/render-fixture.ts", import.meta.url));

try {
	const agent = await import(process.env.PI_TEST_AGENT_ENTRY ?? "@earendil-works/pi-coding-agent");
	const loaded = await agent.discoverAndLoadExtensions([extensionPath, collapsePath, fixturePath], process.cwd(), directory);
	assert.deepEqual(loaded.errors, []);
	const usage = loaded.extensions.find((extension) => extension.path === extensionPath);
	const collapse = loaded.extensions.find((extension) => extension.path === collapsePath);
	const fixture = loaded.extensions.find((extension) => extension.path === fixturePath);
	assert.equal(usage.tools.size, 0, "context usage does not register any tools");
	const theme = { fg: (_color, text) => text, bg: (_color, text) => `\x1b[44m${text}\x1b[49m` };
	const notifications = [];
	const ctx = {
		mode: "tui", cwd: process.cwd(), ui: { theme, notify: (text) => notifications.push(text) }, rows: [],
		codemode: collapse.tools.get("codemode").definition,
	};
	for (const handler of usage.handlers.get("session_start")) await handler({}, ctx);
	await fixture.commands.get("context-render-test").handler("", ctx);
	for (const row of ctx.rows) {
		const annotation = row.render(120).find((line) => line.includes("context tokens"));
		if (row.toolDefinition.renderShell !== "self") {
			assert.match(annotation, / +\x1b\[49m$/, "background includes trailing padding");
		}
	}
	const command = usage.commands.get("tool-context-usage");
	await command.handler("", ctx);
	assert.equal(notifications.at(-1), "Tool context usage is on.");
	await command.handler("invalid", ctx);
	assert.match(notifications.at(-1), /Usage:/);
	await assert.rejects(readFile(configPath), { code: "ENOENT" });

	await command.handler("off", ctx);
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { enabled: false });
	for (const row of ctx.rows) assert.doesNotMatch(row.render(120).join("\n"), /context tokens/);
	for (const handler of usage.handlers.get("session_shutdown")) await handler({}, ctx);

	const reloaded = await agent.discoverAndLoadExtensions([extensionPath], process.cwd(), directory);
	assert.deepEqual(reloaded.errors, []);
	const fresh = reloaded.extensions.find((extension) => extension.path === extensionPath);
	for (const handler of fresh.handlers.get("session_start")) await handler({}, ctx);
	for (const row of ctx.rows) assert.doesNotMatch(row.render(120).join("\n"), /context tokens/);
	await fresh.commands.get("tool-context-usage").handler("", ctx);
	assert.equal(notifications.at(-1), "Tool context usage is off.");
	await fresh.commands.get("tool-context-usage").handler("on", ctx);
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { enabled: true });
	for (const row of ctx.rows) assert.match(row.render(120).join("\n"), /context tokens/);
	for (const handler of fresh.handlers.get("session_shutdown")) await handler({}, ctx);
	for (const row of ctx.rows) assert.doesNotMatch(row.render(120).join("\n"), /context tokens/);
	console.log("PASS: five real tool boxes, collapse-fix coexistence, layout, cleanup, persistent on/off and reload; zero tool registrations.");
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(directory, { recursive: true, force: true });
}
