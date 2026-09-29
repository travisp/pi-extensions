import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

// Compare against the installed host's builder, not a copied prompt fixture.
const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
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
	const warnings = [];
	const ctx = {
		cwd,
		ui: { notify: (message, level) => warnings.push({ message, level }) },
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [{ type: "custom", customType: "prompt-sections-settings", data: settings }] },
		getSystemPromptOptions: () => options,
		getSystemPrompt: () => buildSystemPrompt(options),
	};
	const emit = (name, event) => extension.handlers.get(name)[0](event, ctx);
	const run = async (sections = {}, skills = {}, { restart = true, render = buildSystemPrompt } = {}) => {
		settings = { sections, skills };
		if (restart) await emit("session_start", { reason: "startup" });
		const systemPromptOptions = normalizeBuildSystemPromptOptions(options);
		const before = structuredClone(systemPromptOptions);
		const result = await emit("before_agent_start", {
			get systemPrompt() { return render(systemPromptOptions); },
			systemPromptOptions,
		});
		return { prompt: result?.systemPrompt ?? render(systemPromptOptions), result, systemPromptOptions, before };
	};
	const apply = async (sections = {}, skills = {}) => (await run(sections, skills)).prompt;
	const save = async (path, config) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, typeof config === "string" ? config : JSON.stringify(config));
	};
	return { cwd, agentDir, options, ctx, extension, apply, run, warnings, save };
}

test("structured toggles mutate inputs without forcing a prompt or changing tools", async (t) => {
	const { run, options } = await fixture(t);
	for (const section of ["appendSection", "projectContext", "skills"]) {
		const { result, systemPromptOptions } = await run({ [section]: false });
		assert.equal(result, undefined);
		assert.equal(systemPromptOptions.forceSystemPrompt, undefined);
		assert.deepEqual(systemPromptOptions.selectedTools, options.selectedTools);
		assert.equal(systemPromptOptions.appendSystemPrompt, section === "appendSection" ? "" : options.appendSystemPrompt);
		assert.deepEqual(systemPromptOptions.contextFiles, section === "projectContext" ? [] : options.contextFiles);
		assert.deepEqual(systemPromptOptions.skills, section === "skills" ? [] : options.skills);
	}
	const filtered = await run({}, { deny: ["example"] });
	assert.equal(filtered.result, undefined);
	assert.deepEqual(filtered.systemPromptOptions.skills, []);
	const mixed = await run({ skills: false, piDocumentation: false });
	assert.ok(mixed.result.systemPrompt);
	assert.deepEqual(mixed.systemPromptOptions.skills, []);
	assert.ok(!mixed.prompt.includes("<docs>"));
	assert.ok(!mixed.prompt.includes("<skills>"));
});

test("opaque and malformed prompts leave every input unchanged and warn once per session", async (t) => {
	const { run, options, warnings } = await fixture(t);
	const render = () => "An opaque replacement prompt.";
	const first = await run({ skills: false, intro: false }, {}, { render });
	assert.equal(first.prompt, render());
	assert.equal(first.result, undefined);
	assert.deepEqual(first.systemPromptOptions, first.before);
	await run({}, {}, { restart: false, render });
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].level, "warning");

	for (const malformed of [
		(text) => text.replace("</docs>", ""),
		(text) => text + "\n\n<docs>\nDuplicate\n</docs>",
		(text) => text + "\nUnexpected trailing instructions",
		(text) => text.replace("<cwd>", "<working_directory>"),
	]) {
		const result = await run({ appendSection: false, skills: false }, {}, {
			render: (input) => malformed(buildSystemPrompt(input)),
		});
		assert.equal(result.result, undefined);
		assert.deepEqual(result.systemPromptOptions, result.before);
	}
	options.forceSystemPrompt = buildSystemPrompt(options);
	const forced = await run({ piDocumentation: false, projectContext: false });
	assert.equal(forced.result, undefined);
	assert.deepEqual(forced.systemPromptOptions, forced.before);
	assert.equal(forced.prompt, options.forceSystemPrompt);
	assert.equal(warnings.length, 6);
});

test("validation failure after rebuilding rolls back structured edits", async (t) => {
	const { run, warnings } = await fixture(t);
	const result = await run({ appendSection: false }, {}, {
		render: (input) => input.appendSystemPrompt ? buildSystemPrompt(input) : "Unexpected rebuilt format",
	});
	assert.equal(result.result, undefined);
	assert.deepEqual(result.systemPromptOptions, result.before);
	assert.equal(warnings.length, 1);
});

test("custom preamble tags and same-name nested addendum tags are not section boundaries", async (t) => {
	const { options, run } = await fixture(t);
	options.customPrompt = "My role.\n\n<docs>\nMy docs\n</docs>";
	options.appendSystemPrompt = "Before\n<addendum>\nNested\n</addendum>\nAfter";
	options.sections = { extra: "Custom extra" };
	const { prompt } = await run({ runtimeContext: false, piDocumentation: false });
	assert.ok(prompt.startsWith(options.customPrompt));
	assert.ok(prompt.includes(options.appendSystemPrompt));
	assert.ok(prompt.includes("<extra>\nCustom extra\n</extra>"));
	assert.ok(!prompt.includes("<cwd>"));
});

test("custom generated-section overrides respect whole-section toggles", async (t) => {
	const { options, run, warnings } = await fixture(t);
	options.sections = { addendum: "Override addendum", project_context: "Override project", skills: "Opaque skills" };
	const disabled = await run({ appendSection: false, projectContext: false, skills: false });
	assert.equal(disabled.result, undefined);
	assert.deepEqual(disabled.systemPromptOptions.sections, {});
	assert.ok(!disabled.prompt.includes("Override"));
	const individual = await run({}, { deny: ["example"] });
	assert.equal(individual.result, undefined);
	assert.deepEqual(individual.systemPromptOptions, individual.before);
	assert.equal(warnings.length, 1);
});

test("unsupported prompt preview stays available without showing filtering as applied", async (t) => {
	const { options, ctx, extension } = await fixture(t);
	options.forceSystemPrompt = "Opaque prompt that must stay intact.";
	ctx.ui.custom = async (factory) => {
		const theme = { fg: (_color, text) => text, bold: (text) => text };
		const component = factory({ terminal: { rows: 50 } }, theme, {}, () => {});
		const rendered = component.render(180).join("\n");
		assert.ok(rendered.includes("filtering unavailable"));
		assert.ok(rendered.includes(options.forceSystemPrompt));
		assert.ok(!rendered.includes("[disabled]"));
		component.handleInput("\r");
		assert.ok(component.render(180).join("\n").includes(options.forceSystemPrompt));
		component.handleInput("p");
		assert.ok(component.render(180).join("\n").includes(options.forceSystemPrompt));
	};
	await extension.commands.get("prompt-ninja").handler("", ctx);
});

test("each prompt-section toggle preserves the other sections of the current Pi prompt", async (t) => {
	const { apply, options } = await fixture(t);
	assert.equal(await apply(), buildSystemPrompt(options));
	const sections = {
		intro: "You are an expert coding assistant",
		tools: "<tools>",
		guidelines: "- Be concise in your responses",
		piDocumentation: "Pi documentation (read only",
		appendSection: "Keep this appended guideline.",
		projectContext: "Keep these project instructions.",
		skills: "<available_skills>",
		runtimeContext: "<cwd>",
	};
	for (const [disabled, marker] of Object.entries(sections)) {
		const prompt = await apply({ [disabled]: false });
		assert.ok(!prompt.includes(marker), `${disabled} should be removed`);
		for (const [enabled, otherMarker] of Object.entries(sections)) {
			if (enabled !== disabled) assert.ok(prompt.includes(otherMarker), `${disabled} must preserve ${enabled}`);
		}
	}
});

test("skill filtering handles read and bash prompts without leaving empty wrappers", async (t) => {
	const { apply, options } = await fixture(t);
	options.skills.push({ ...options.skills[0], name: "second", description: "Second skill" });
	for (const tool of ["read", "bash"]) {
		options.selectedTools = [tool];
		const filtered = await apply({}, { deny: ["example"] });
		assert.ok(!filtered.includes("<name>example</name>"));
		assert.ok(filtered.includes("<name>second</name>"));
		const empty = await apply({}, { deny: ["example", "second"] });
		assert.ok(!empty.includes("<skills>"));
		assert.ok(empty.includes("<cwd>"));
	}
});

test("nested section tags and custom sections survive unrelated toggles", async (t) => {
	const { apply, options } = await fixture(t);
	options.appendSystemPrompt = "Extra instructions.\n\n<docs>\nKeep nested docs.\n</docs>";
	options.sections = { extra: "Keep custom section." };
	const prompt = await apply({ piDocumentation: false, runtimeContext: false });
	assert.ok(prompt.includes(options.appendSystemPrompt));
	assert.ok(prompt.includes("<extra>\nKeep custom section.\n</extra>"));
	assert.ok(!prompt.includes("Pi documentation (read only"));
});

test("Pi documentation removal preserves project and cwd without append text or skills", async (t) => {
	const { apply, options } = await fixture(t);
	delete options.appendSystemPrompt;
	options.skills = [];
	const prompt = await apply({ piDocumentation: false });
	assert.ok(!prompt.includes("Pi documentation (read only"));
	assert.ok(prompt.includes("<project_context>"));
	assert.ok(prompt.includes("Keep these project instructions."));
	assert.ok(prompt.endsWith(`<cwd>\n${options.cwd}\n</cwd>`));
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
	assert.ok(!prompt.includes("<cwd>"));
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
	assert.ok(!trustedPrompt.includes("<tools>"));
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
