import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

// Compare against the installed host's builder, not a copied prompt fixture.
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extensionPath = fileURLToPath(new URL("../extensions/prompt-ninja/src/pi-prompt-ninja.ts", import.meta.url));

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "prompt-ninja-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "parent", "project");
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(root, { recursive: true, force: true });
	});
	await mkdir(cwd, { recursive: true });
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, agentDir);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions.find((item) => item.path === extensionPath);
	const options = {
		cwd,
		selectedTools: ["read"],
		toolSnippets: { read: "Read files" },
		appendSystemPrompt: "Additional instructions.\n\nGuidelines:\nKeep this appended guideline.",
		contextFiles: [{ path: join(cwd, "AGENTS.md"), content: "Keep these project instructions." }],
		skills: [{ name: "example", description: "Example skill", filePath: join(cwd, "SKILL.md"), baseDir: cwd, source: "test", disableModelInvocation: false }],
	};
	let settings = {};
	const ctx = {
		cwd,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [{ type: "custom", customType: "prompt-sections-settings", data: settings }] },
		getSystemPromptOptions: () => options,
		getSystemPrompt: () => buildSystemPrompt(options),
	};
	const emit = (name, event) => extension.handlers.get(name)[0](event, ctx);
	const apply = async (sections = {}) => {
		settings = { sections };
		await emit("session_start", { reason: "startup" });
		const systemPrompt = buildSystemPrompt(options);
		const result = await emit("before_agent_start", { systemPrompt, systemPromptOptions: options });
		return result?.systemPrompt ?? systemPrompt;
	};
	const save = async (path, config) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, typeof config === "string" ? config : JSON.stringify(config));
	};
	return { cwd, agentDir, options, ctx, extension, apply, save };
}

test("each prompt-section toggle preserves the other sections of the current Pi prompt", async (t) => {
	const { apply, options } = await fixture(t);
	assert.equal(await apply(), buildSystemPrompt(options));
	const sections = {
		intro: "You are an expert coding assistant",
		tools: "Available tools:",
		guidelines: "- Be concise in your responses",
		piDocumentation: "Pi documentation (read only",
		appendSection: "Keep this appended guideline.",
		projectContext: "Keep these project instructions.",
		skills: "<available_skills>",
		runtimeContext: `Current working directory: ${options.cwd}`,
	};
	for (const [disabled, marker] of Object.entries(sections)) {
		const prompt = await apply({ [disabled]: false });
		assert.ok(!prompt.includes(marker), `${disabled} should be removed`);
		for (const [enabled, otherMarker] of Object.entries(sections)) {
			if (enabled !== disabled) assert.ok(prompt.includes(otherMarker), `${disabled} must preserve ${enabled}`);
		}
	}
});

test("Pi documentation removal preserves project and cwd without append text or skills", async (t) => {
	const { apply, options } = await fixture(t);
	delete options.appendSystemPrompt;
	options.skills = [];
	const prompt = await apply({ piDocumentation: false });
	assert.ok(!prompt.includes("Pi documentation (read only"));
	assert.ok(prompt.includes("<project_context>"));
	assert.ok(prompt.includes("Keep these project instructions."));
	assert.ok(prompt.endsWith(`Current working directory: ${options.cwd}`));
});

test("custom prompts retain their own headings when built-in sections are disabled", async (t) => {
	const { apply, options } = await fixture(t);
	options.customPrompt = "Custom identity.";
	options.contextFiles[0].content = "Guidelines:\n\nPi documentation notes belonging to the project.";
	assert.equal(await apply({ piDocumentation: false, guidelines: false }), buildSystemPrompt(options));
	const prompt = await apply({ projectContext: false, runtimeContext: false });
	assert.ok(prompt.includes("Custom identity."));
	assert.ok(prompt.includes("Additional instructions."));
	assert.ok(!prompt.includes("<project_context>"));
	assert.ok(!prompt.includes("Current working directory:"));
});

test("untrusted project and ancestor configs are not read; global and session settings still work", async (t) => {
	const { cwd, agentDir, ctx, apply, save } = await fixture(t);
	const directoryPath = join(cwd, ".pi", "prompt-sections.json");
	const parentPath = join(dirname(cwd), ".pi", "prompt-sections.json");
	await save(directoryPath, "invalid JSON must not be read");
	await save(parentPath, "invalid JSON must not be read");
	await save(join(agentDir, "extensions", "prompt-sections.json"), { sections: { piDocumentation: false } });
	ctx.isProjectTrusted = () => false;
	const prompt = await apply();
	assert.ok(prompt.includes("- Be concise in your responses"));
	assert.ok(!prompt.includes("Pi documentation (read only"));
	assert.ok((await apply({ piDocumentation: true })).includes("Pi documentation (read only"));

	await save(directoryPath, { sections: { guidelines: true } });
	await save(parentPath, { sections: { guidelines: false, tools: false } });
	ctx.isProjectTrusted = () => true;
	const trustedPrompt = await apply();
	assert.ok(trustedPrompt.includes("- Be concise in your responses"));
	assert.ok(!trustedPrompt.includes("Available tools:"));
});

test("settings UI ignores and cannot edit untrusted directory configuration", async (t) => {
	const { cwd, ctx, extension, apply, save } = await fixture(t);
	const configPath = join(cwd, ".pi", "prompt-sections.json");
	const original = '{"sections":{"guidelines":false}}';
	await save(configPath, original);
	ctx.isProjectTrusted = () => false;
	await apply();
	ctx.ui = {
		custom: async (factory) => {
			const theme = { fg: (_color, text) => text, bold: (text) => text };
			const component = factory({ terminal: { rows: 50 } }, theme, {}, () => {});
			assert.ok(component.render(160).join("\n").includes("untrusted"));
			component.handleInput("\x1b[B"); // Intro row
			component.handleInput("d");
		},
	};
	await extension.commands.get("prompt-ninja").handler("", ctx);
	assert.equal(await readFile(configPath, "utf8"), original);
});
