import { formatSkillsForPrompt, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { PromptSectionName } from "./prompt-config.js";

export type PromptOptions = BuildSystemPromptOptions;
export type PromptSection = {
	name: PromptSectionName | "custom";
	start: number;
	end: number;
	text: string;
};

const SECTION_NAMES: Record<string, PromptSectionName> = {
	tools: "tools", rules: "guidelines", docs: "piDocumentation",
	addendum: "appendSection", project_context: "projectContext",
	skills: "skills", cwd: "runtimeContext",
};

/** Validate the complete envelope before treating any text as removable instructions. */
export function inspectPrompt(text: string, options: PromptOptions): PromptSection[] | undefined {
	if (options.forceSystemPrompt !== undefined) return undefined;
	const sections: PromptSection[] = [];
	let cursor = 0;
	const add = (name: PromptSection["name"], end: number) => {
		sections.push({ name, start: cursor, end, text: text.slice(cursor, end) });
		cursor = end;
	};

	if (options.customPrompt) {
		if (!text.startsWith(options.customPrompt)) return undefined;
		add("intro", options.customPrompt.length);
	} else {
		const end = text.indexOf("\n\n<tools>\n");
		if (end < 0 || !text.startsWith("You are an expert coding assistant operating inside pi,")) return undefined;
		add("intro", end);
	}

	const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const readTool = tools.find((tool) => tool === "read") ?? tools.find((tool) => tool === "bash");
	const skillText = readTool ? formatSkillsForPrompt(options.skills ?? [], readTool).trim() : "";
	const expected = new Set(options.customPrompt ? [] : ["tools", "rules", "docs"]);
	if (options.appendSystemPrompt) expected.add("addendum");
	if (options.contextFiles?.length) expected.add("project_context");
	if (skillText) expected.add("skills");
	expected.add("cwd");
	for (const [tag, content] of Object.entries(options.sections ?? {})) {
		if (content) expected.add(tag);
	}
	const knownBodies: Record<string, string | undefined> = {
		addendum: options.appendSystemPrompt,
		skills: skillText,
		cwd: options.cwd.replace(/\\/g, "/"),
	};
	for (const [tag, content] of Object.entries(options.sections ?? {})) {
		if (content) knownBodies[tag] = content;
	}

	while (cursor < text.length) {
		const separator = text.slice(cursor).match(/^\s*/)?.[0] ?? "";
		cursor += separator.length;
		if (cursor === text.length) break;
		const opening = text.slice(cursor).match(/^<([a-z][a-z0-9_-]*)>\n/);
		if (!opening || !expected.delete(opening[1])) return undefined;
		const tag = opening[1];
		const bodyStart = cursor + opening[0].length;
		const closing = `\n</${tag}>`;
		const body = knownBodies[tag];
		// Known user-controlled bodies are matched literally, including nested tags.
		const closeStart = body === undefined ? text.indexOf(closing, bodyStart) : bodyStart + body.length;
		if (closeStart < 0 || text.slice(closeStart, closeStart + closing.length) !== closing) return undefined;
		if (body !== undefined && text.slice(bodyStart, closeStart) !== body) return undefined;
		add(SECTION_NAMES[tag] ?? "custom", closeStart + closing.length);
	}
	return expected.size === 0 ? sections : undefined;
}
