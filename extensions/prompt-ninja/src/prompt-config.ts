import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SettingsScope = "session" | "directory" | "global";
export type ConfigColumnId = SettingsScope | "parent";
export type CellState = "unset" | "on" | "off";

export type PromptSectionName = "intro" | "tools" | "guidelines" | "piDocumentation" | "appendSection" | "projectContext" | "skills" | "runtimeContext";

export type SectionSettings = Record<PromptSectionName, boolean>;

export type SkillSettings = {
	/** Explicit default for all configurable skills in this scope. */
	default?: boolean;
	/** Per-skill explicit enables. */
	allow?: string[];
	/** Per-skill explicit disables. */
	deny?: string[];
};

export type PromptSectionsConfig = {
	sections?: Partial<SectionSettings>;
	skills?: SkillSettings;
};

export type ConfigColumn = {
	id: ConfigColumnId;
	label: string;
	config: PromptSectionsConfig;
	editableScope?: SettingsScope;
};

const CONFIG_FILE_NAME = "prompt-sections.json";
const PROMPT_SECTION_NAMES: PromptSectionName[] = ["intro", "tools", "guidelines", "piDocumentation", "appendSection", "projectContext", "skills", "runtimeContext"];

export const EDITABLE_SCOPES: SettingsScope[] = ["session", "directory", "global"];

export function loadConfigColumns(cwd: string, sessionConfig: PromptSectionsConfig): ConfigColumn[] {
	return [
		{ id: "session", label: "Session", config: sessionConfig, editableScope: "session" },
		{ id: "directory", label: "Directory", config: readConfig(directoryConfigPath(cwd)), editableScope: "directory" },
		{ id: "parent", label: "Parent", config: readParentConfig(cwd) },
		{ id: "global", label: "Global", config: readConfig(globalConfigPath()), editableScope: "global" },
	];
}

export function configForScope(columns: ConfigColumn[], scope: SettingsScope): PromptSectionsConfig {
	return configColumnForScope(columns, scope).config;
}

export function configColumnForScope(columns: ConfigColumn[], scope: SettingsScope): ConfigColumn {
	const column = columns.find((candidate) => candidate.editableScope === scope);
	if (!column) throw new Error(`Missing config column for scope: ${scope}`);
	return column;
}

export function writeScopedConfig(scope: Exclude<SettingsScope, "session">, cwd: string, config: PromptSectionsConfig): void {
	writeConfig(scope === "global" ? globalConfigPath() : directoryConfigPath(cwd), config);
}

export function cleanConfig(config: PromptSectionsConfig): void {
	if (config.sections && Object.keys(config.sections).length === 0) delete config.sections;
	if (config.skills?.allow?.length === 0) delete config.skills.allow;
	if (config.skills?.deny?.length === 0) delete config.skills.deny;
	if (config.skills && Object.keys(config.skills).length === 0) delete config.skills;
}

function readParentConfig(cwd: string): PromptSectionsConfig {
	// Read root-to-nearest so nearer parent directories override farther ones.
	return mergePromptConfigs(parentDirectoryConfigPaths(cwd).map(readConfig));
}

function parentDirectoryConfigPaths(cwd: string): string[] {
	const nearestFirst: string[] = [];
	let directory = resolve(cwd);

	while (true) {
		const parent = dirname(directory);
		if (parent === directory) break;
		nearestFirst.push(directoryConfigPath(parent));
		directory = parent;
	}

	return nearestFirst.reverse();
}

function mergePromptConfigs(configs: PromptSectionsConfig[]): PromptSectionsConfig {
	const merged: PromptSectionsConfig = {};
	for (const config of configs) mergePromptConfig(merged, config);
	cleanConfig(merged);
	return merged;
}

function mergePromptConfig(target: PromptSectionsConfig, source: PromptSectionsConfig): void {
	if (source.sections) {
		target.sections ??= {};
		for (const section of PROMPT_SECTION_NAMES) {
			if (hasOwn(source.sections, section)) target.sections[section] = source.sections[section];
		}
	}

	if (source.skills) {
		target.skills ??= {};
		if (source.skills.default !== undefined) {
			target.skills.default = source.skills.default;
			delete target.skills.allow;
			delete target.skills.deny;
		}
		for (const skillName of source.skills.allow ?? []) setSkillCell(target, skillName, "on");
		for (const skillName of source.skills.deny ?? []) setSkillCell(target, skillName, "off");
	}
}

export function sectionCell(config: PromptSectionsConfig, section: keyof SectionSettings): CellState {
	const sections = config.sections;
	if (!hasOwn(sections, section)) return "unset";
	return sections[section] ? "on" : "off";
}

export function setSectionCell(config: PromptSectionsConfig, section: keyof SectionSettings, state: CellState): void {
	config.sections ??= {};
	if (state === "unset") delete config.sections[section];
	else config.sections[section] = state === "on";
	cleanConfig(config);
}

export function skillCell(config: PromptSectionsConfig, skillName: string): CellState {
	const skills = config.skills;
	if (skills?.allow?.includes(skillName)) return "on";
	if (skills?.deny?.includes(skillName)) return "off";
	return "unset";
}

export function setSkillCell(config: PromptSectionsConfig, skillName: string, state: CellState): void {
	config.skills ??= {};
	const allow = new Set(config.skills.allow ?? []);
	const deny = new Set(config.skills.deny ?? []);
	allow.delete(skillName);
	deny.delete(skillName);
	if (state === "on") allow.add(skillName);
	if (state === "off") deny.add(skillName);
	config.skills.allow = sortedStrings(allow);
	config.skills.deny = sortedStrings(deny);
	cleanConfig(config);
}

export function allSkillsCell(config: PromptSectionsConfig): CellState {
	const settings = config.skills;
	if (!hasOwn(settings, "default")) return "unset";
	return settings.default ? "on" : "off";
}

export function setAllSkillsCell(config: PromptSectionsConfig, state: CellState): void {
	config.skills ??= {};
	if (state === "unset") delete config.skills.default;
	else config.skills.default = state === "on";
	cleanConfig(config);
}

function hasOwn<T extends object, K extends PropertyKey>(object: T | undefined, key: K): object is T & Record<K, unknown> {
	return object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

function globalConfigPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

function directoryConfigPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_FILE_NAME);
}

function readConfig(path: string): PromptSectionsConfig {
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf-8")) as PromptSectionsConfig;
}

function writeConfig(path: string, config: PromptSectionsConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function sortedStrings(values: Set<string>): string[] {
	return [...values].sort((a, b) => a.localeCompare(b));
}
