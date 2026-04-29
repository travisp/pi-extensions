import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DefaultResourceLoader,
	formatSkillsForPrompt,
	getAgentDir,
	SettingsManager,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";

type SettingsScope = "session" | "directory" | "global";
type CellState = "unset" | "on" | "off";

type SectionSettings = {
	piDocumentation: boolean;
};

type SkillSettings = {
	/** Explicit default for all configurable skills in this scope. */
	default?: boolean;
	/** Per-skill explicit enables. */
	allow?: string[];
	/** Per-skill explicit disables. */
	deny?: string[];
};

type PromptSectionsConfig = {
	sections?: Partial<SectionSettings>;
	skills?: SkillSettings;
};

type ScopedConfigs = Record<SettingsScope, PromptSectionsConfig>;

type MatrixRow = {
	id: string;
	label: string;
	description?: string;
	effective: () => string;
	cell?: (scope: SettingsScope) => CellState;
	setCell?: (scope: SettingsScope, state: CellState) => void;
	open?: (done: () => void) => Component;
};

type Theme = {
	bold?: (text: string) => string;
	fg?: (color: string, text: string) => string;
};

type MatrixOptions = {
	title: string;
	theme?: Theme;
	done: () => void;
	reset: () => void;
	search?: boolean;
};

const DEFAULT_SECTIONS: SectionSettings = {
	// Match Pi's normal behavior unless the user disables this section.
	piDocumentation: true,
};

const CONFIG_FILE_NAME = "prompt-sections.json";
const SESSION_SETTINGS_ENTRY_TYPE = "prompt-sections-settings";
const SCOPES: SettingsScope[] = ["session", "directory", "global"];

let sessionConfig: PromptSectionsConfig = {};

export default function promptSections(pi: ExtensionAPI) {
	pi.registerCommand("prompt-sections", {
		description: "Configure generated system prompt sections and skill visibility",
		handler: async (_args, ctx) => {
			await showSettings(ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionConfig = readSessionConfig(ctx.sessionManager.getBranch());
	});

	pi.on("before_agent_start", async (event) => {
		const sections = effectiveSections(event.systemPromptOptions.cwd);

		if (event.systemPromptOptions.customPrompt || sections.piDocumentation) {
			return filterSkillsInExistingPrompt(event.systemPrompt, event.systemPromptOptions);
		}

		return { systemPrompt: buildPromptWithoutPiDocs(event.systemPromptOptions) };
	});
}

function buildPromptWithoutPiDocs(options: BuildSystemPromptOptions): string {
	const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const toolsList = formatToolsList(tools, options.toolSnippets ?? {});
	const guidelines = buildGuidelines(options).map((text) => `- ${text}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}`;

	if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`;
	prompt = appendProjectContext(prompt, options.contextFiles ?? []);
	prompt = appendSkills(prompt, options);
	return appendDateAndCwd(prompt, options.cwd);
}

function formatToolsList(tools: string[], toolSnippets: Record<string, string>): string {
	const visibleTools = tools.filter((name) => toolSnippets[name]);
	if (visibleTools.length === 0) return "(none)";
	return visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n");
}

function buildGuidelines(options: BuildSystemPromptOptions): string[] {
	const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const guidelines = new Set<string>();

	const hasBash = tools.includes("bash");
	const hasDedicatedSearchTools = tools.includes("grep") || tools.includes("find") || tools.includes("ls");

	if (hasBash && !hasDedicatedSearchTools) {
		guidelines.add("Use bash for file operations like ls, rg, find");
	} else if (hasBash && hasDedicatedSearchTools) {
		guidelines.add("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of options.promptGuidelines ?? []) {
		const trimmed = guideline.trim();
		if (trimmed) guidelines.add(trimmed);
	}

	guidelines.add("Be concise in your responses");
	guidelines.add("Show file paths clearly when working with files");
	return [...guidelines];
}

function appendProjectContext(prompt: string, contextFiles: NonNullable<BuildSystemPromptOptions["contextFiles"]>): string {
	if (contextFiles.length === 0) return prompt;

	let next = `${prompt}\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n`;
	for (const { path, content } of contextFiles) {
		next += `## ${path}\n\n${content}\n\n`;
	}
	return next;
}

function appendSkills(prompt: string, options: BuildSystemPromptOptions): string {
	const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const skills = options.skills ?? [];
	if (!tools.includes("read") || skills.length === 0) return prompt;
	return prompt + formatSkillsForPrompt(visibleSkills(skills, options.cwd));
}

function appendDateAndCwd(prompt: string, cwd: string): string {
	return `${prompt}\nCurrent date: ${formatDate()}\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`;
}

function filterSkillsInExistingPrompt(systemPrompt: string, options: BuildSystemPromptOptions) {
	const skills = options.skills ?? [];
	const currentSkillBlock = formatSkillsForPrompt(skills);
	if (!currentSkillBlock) return undefined;

	const nextSkillBlock = formatSkillsForPrompt(visibleSkills(skills, options.cwd));
	const nextPrompt = systemPrompt.replace(currentSkillBlock, nextSkillBlock);
	return nextPrompt === systemPrompt ? undefined : { systemPrompt: nextPrompt };
}

async function showSettings(ctx: ExtensionCommandContext, pi: Pick<ExtensionAPI, "appendEntry">): Promise<void> {
	const skills = await loadSkills(ctx.cwd);
	const configs = loadScopedConfigs(ctx.cwd);
	const saveScope = (scope: SettingsScope) => saveScopedConfig(scope, ctx.cwd, configs[scope], pi);

	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const rows = mainRows(skills, configs, saveScope);
		return createMatrix(rows, {
			title: "Prompt sections",
			theme,
			reset: () => resetAllSettings(configs, saveScope),
			done: () => done(undefined),
		});
	});
}

function mainRows(skills: Skill[], configs: ScopedConfigs, saveScope: (scope: SettingsScope) => void): MatrixRow[] {
	return [
		{
			id: "piDocumentation",
			label: "Pi documentation",
			description: "Include Pi's built-in documentation pointers in the system prompt.",
			effective: () => onOff(resolveSection(configs, "piDocumentation")),
			cell: (scope) => sectionCell(configs[scope], "piDocumentation"),
			setCell: (scope, state) => {
				setSectionCell(configs[scope], "piDocumentation", state);
				saveScope(scope);
			},
		},
		{
			id: "skills",
			label: "Skill invocations in prompt",
			description: "Enter opens individual skills.",
			effective: () => skillsSummary(skills, effectiveAllowedSkillNames(configs, skills)),
			open: (done) => createSkillsMatrix(skills, configs, saveScope, done),
		},
	];
}

function createSkillsMatrix(skills: Skill[], configs: ScopedConfigs, saveScope: (scope: SettingsScope) => void, done: () => void): Component {
	const rows: MatrixRow[] = [
		{
			id: "__all",
			label: "All skills",
			description: "Press s, d, or g to toggle all skills at that scope.",
			effective: () => skillsSummary(skills, effectiveAllowedSkillNames(configs, skills)),
			cell: (scope) => allSkillsCell(configs[scope]),
			setCell: (scope, state) => {
				setAllSkillsCell(configs[scope], state);
				saveScope(scope);
			},
		},
		...configurableSkills(skills)
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((skill): MatrixRow => ({
				id: skill.name,
				label: skill.name,
				description: skill.description,
				effective: () => onOff(effectiveSkillEnabled(configs, skill.name)),
				cell: (scope) => skillCell(configs[scope], skill.name),
				setCell: (scope, state) => {
					setSkillCell(configs[scope], skill.name, state);
					saveScope(scope);
				},
			})),
	];

	return createMatrix(rows, {
		title: "Skill invocations in prompt",
		theme: undefined,
		reset: () => resetSkillSettings(configs, saveScope),
		done,
		search: true,
	});
}

function createMatrix(rows: MatrixRow[], options: MatrixOptions): Component {
	let selectedRow = 0;
	let query = "";
	let child: Component | undefined;

	const visibleRows = () => {
		if (!options.search || !query) return rows;
		return rows.filter((row) => row.id === "__all" || row.label.toLowerCase().includes(query.toLowerCase()));
	};

	const selected = () => visibleRows()[selectedRow];

	return {
		render: (width) => {
			if (child) return child.render(width);

			const rowsToRender = visibleRows();
			if (selectedRow >= rowsToRender.length) selectedRow = Math.max(0, rowsToRender.length - 1);

			const lines: string[] = [];
			lines.push(truncate(styleTitle(options.theme, options.title), width));
			if (options.search) lines.push(truncate(`Search: ${query}`, width));
			lines.push(formatHeader(width, options.theme));

			const start = Math.max(0, Math.min(selectedRow - 7, Math.max(0, rowsToRender.length - 15)));
			const end = Math.min(start + 15, rowsToRender.length);
			for (let i = start; i < end; i++) {
				lines.push(formatRow(rowsToRender[i], i === selectedRow, width));
			}

			if (start > 0 || end < rowsToRender.length) lines.push(`  (${selectedRow + 1}/${rowsToRender.length})`);

			const row = selected();
			if (row?.description) {
				lines.push("");
				for (const line of wrapTextWithAnsi(row.description, Math.max(1, width - 2))) {
					lines.push(truncate(`  ${line}`, width));
				}
			}
			lines.push("", truncate(options.search
				? "  ↑/↓ row · s session · d directory · g global · r reset · Type search · Esc back"
				: "  ↑/↓ row · s session · d directory · g global · r reset · Esc close", width));
			return lines;
		},
		invalidate: () => child?.invalidate?.(),
		handleInput: (data) => {
			if (child) {
				child.handleInput?.(data);
				return;
			}

			const rowsNow = visibleRows();
			if (isResetKey(data)) {
				options.reset();
				return;
			}

			if (rowsNow.length === 0) {
				if (isEscape(data)) options.done();
				else if (options.search) handleSearchInput(data);
				return;
			}

			if (isUp(data)) selectedRow = selectedRow === 0 ? rowsNow.length - 1 : selectedRow - 1;
			else if (isDown(data)) selectedRow = selectedRow === rowsNow.length - 1 ? 0 : selectedRow + 1;
			else if (isScopeKey(data)) toggleSelectedCell(scopeFromKey(data));
			else if (isEscape(data)) options.done();
			else if (isEnter(data)) activateSelectedRow();
			else if (options.search) handleSearchInput(data);
		},
	};

	function activateSelectedRow(): void {
		const row = selected();
		if (!row?.open) return;
		child = row.open(() => {
			child = undefined;
		});
	}

	function toggleSelectedCell(scope: SettingsScope): void {
		const row = selected();
		if (!row?.setCell || !row.cell) return;
		row.setCell(scope, nextCellState(row.cell(scope)));
	}

	function handleSearchInput(data: string): void {
		if (data === "\u007f" || data === "\b") {
			query = query.slice(0, -1);
			selectedRow = 0;
			return;
		}
		if (/^[\x20-\x7e]$/.test(data) && data !== " ") {
			query += data;
			selectedRow = 0;
		}
	}
}

function formatHeader(width: number, theme: Theme | undefined): string {
	return truncate(boldText(theme, `  ${pad("Setting", 30)}  ${pad("Effective", 12)}  ${pad("Session", 9)}  ${pad("Directory", 9)}  ${pad("Global", 9)}`), width);
}

function formatRow(row: MatrixRow, selected: boolean, width: number): string {
	const values = SCOPES.map((scope) => formatCell(row.cell?.(scope) ?? "unset"));
	const prefix = selected ? "▸ " : "  ";
	return truncate(`${prefix}${pad(row.label, 30)}  ${pad(row.effective(), 12)}  ${values.join("  ")}`, width);
}

function formatCell(value: CellState): string {
	return pad(value === "unset" ? "—" : value, 9);
}

function pad(text: string, width: number): string {
	const value = truncate(text, width);
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function truncate(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "");
}

function styleTitle(theme: Theme | undefined, title: string): string {
	return theme?.fg ? theme.fg("accent", boldText(theme, title)) : boldText(theme, title);
}

function boldText(theme: Theme | undefined, text: string): string {
	return theme?.bold ? theme.bold(text) : `\u001b[1m${text}\u001b[22m`;
}

function nextCellState(current: CellState): CellState {
	if (current === "unset") return "on";
	if (current === "on") return "off";
	return "unset";
}

function sectionCell(config: PromptSectionsConfig, section: keyof SectionSettings): CellState {
	if (!hasOwn(config.sections, section)) return "unset";
	return config.sections?.[section] ? "on" : "off";
}

function setSectionCell(config: PromptSectionsConfig, section: keyof SectionSettings, state: CellState): void {
	config.sections ??= {};
	if (state === "unset") delete config.sections[section];
	else config.sections[section] = state === "on";
	cleanConfig(config);
}

function resolveSection(configs: ScopedConfigs, section: keyof SectionSettings): boolean {
	for (const scope of SCOPES) {
		const state = sectionCell(configs[scope], section);
		if (state !== "unset") return state === "on";
	}
	return DEFAULT_SECTIONS[section];
}

function skillCell(config: PromptSectionsConfig, skillName: string): CellState {
	const skills = config.skills;
	if (skills?.allow?.includes(skillName)) return "on";
	if (skills?.deny?.includes(skillName)) return "off";
	return "unset";
}

function setSkillCell(config: PromptSectionsConfig, skillName: string, state: CellState): void {
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

function allSkillsCell(config: PromptSectionsConfig): CellState {
	if (!hasOwn(config.skills, "default")) return "unset";
	return config.skills?.default ? "on" : "off";
}

function setAllSkillsCell(config: PromptSectionsConfig, state: CellState): void {
	config.skills ??= {};
	if (state === "unset") delete config.skills.default;
	else config.skills.default = state === "on";
	cleanConfig(config);
}

function effectiveSkillEnabled(configs: ScopedConfigs, skillName: string): boolean {
	for (const scope of SCOPES) {
		const state = effectiveSkillCell(configs[scope], skillName);
		if (state !== "unset") return state === "on";
	}
	return true;
}

function effectiveSkillCell(config: PromptSectionsConfig, skillName: string): CellState {
	const state = skillCell(config, skillName);
	if (state !== "unset") return state;
	if (!hasOwn(config.skills, "default")) return "unset";
	return config.skills?.default ? "on" : "off";
}

function effectiveAllowedSkillNames(configs: ScopedConfigs, skills: Skill[]): Set<string> {
	return new Set(visibleByDefaultSkillNames(skills).filter((name) => effectiveSkillEnabled(configs, name)));
}

function skillsSummary(skills: Skill[], allowedSkills: Set<string>): string {
	return `${visibleSkillCount(skills, allowedSkills)}/${visibleByDefaultSkillNames(skills).length} visible`;
}

function visibleSkillCount(skills: Skill[], allowedSkills: Set<string>): number {
	return configurableSkills(skills).filter((skill) => allowedSkills.has(skill.name)).length;
}

function visibleSkills(skills: Skill[], cwd: string): Skill[] {
	const configs = loadScopedConfigs(cwd);
	const allowedSkills = effectiveAllowedSkillNames(configs, skills);
	return configurableSkills(skills).filter((skill) => allowedSkills.has(skill.name));
}

function visibleByDefaultSkillNames(skills: Skill[]): string[] {
	return configurableSkills(skills).map((skill) => skill.name);
}

function configurableSkills(skills: Skill[]): Skill[] {
	return skills.filter((skill) => !skill.disableModelInvocation);
}

function resetAllSettings(configs: ScopedConfigs, saveScope: (scope: SettingsScope) => void): void {
	for (const scope of SCOPES) {
		delete configs[scope].sections;
		delete configs[scope].skills;
		saveScope(scope);
	}
}

function resetSkillSettings(configs: ScopedConfigs, saveScope: (scope: SettingsScope) => void): void {
	for (const scope of SCOPES) {
		delete configs[scope].skills;
		saveScope(scope);
	}
}

function cleanConfig(config: PromptSectionsConfig): void {
	if (config.sections && Object.keys(config.sections).length === 0) delete config.sections;
	if (config.skills?.allow?.length === 0) delete config.skills.allow;
	if (config.skills?.deny?.length === 0) delete config.skills.deny;
	if (config.skills && Object.keys(config.skills).length === 0) delete config.skills;
}

function effectiveSections(cwd: string): SectionSettings {
	const configs = loadScopedConfigs(cwd);
	return { piDocumentation: resolveSection(configs, "piDocumentation") };
}

function loadScopedConfigs(cwd: string): ScopedConfigs {
	return {
		session: sessionConfig,
		directory: readConfig(directoryConfigPath(cwd)),
		global: readConfig(globalConfigPath()),
	};
}

function saveScopedConfig(scope: SettingsScope, cwd: string, config: PromptSectionsConfig, pi: Pick<ExtensionAPI, "appendEntry">): void {
	if (scope === "session") {
		sessionConfig = config;
		pi.appendEntry(SESSION_SETTINGS_ENTRY_TYPE, config);
		return;
	}

	writeConfig(scope === "global" ? globalConfigPath() : directoryConfigPath(cwd), config);
}

function readSessionConfig(entries: unknown[]): PromptSectionsConfig {
	let config: PromptSectionsConfig = {};
	for (const entry of entries) {
		if (isSessionSettingsEntry(entry)) config = entry.data;
	}
	return config;
}

function isSessionSettingsEntry(entry: unknown): entry is { type: "custom"; customType: string; data: PromptSectionsConfig } {
	return isObject(entry) && entry.type === "custom" && entry.customType === SESSION_SETTINGS_ENTRY_TYPE && isObject(entry.data);
}

async function loadSkills(cwd: string): Promise<Skill[]> {
	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
	await resourceLoader.reload();
	return resourceLoader.getSkills().skills;
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

function formatDate(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function onOff(value: boolean): "on" | "off" {
	return value ? "on" : "off";
}

function hasOwn<T extends object>(object: T | undefined, key: PropertyKey): boolean {
	return object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.up");
}

function isDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.down");
}

function isScopeKey(data: string): boolean {
	return data.toLowerCase() === "s" || data.toLowerCase() === "d" || data.toLowerCase() === "g";
}

function isResetKey(data: string): boolean {
	return data.toLowerCase() === "r";
}

function scopeFromKey(data: string): SettingsScope {
	const key = data.toLowerCase();
	if (key === "d") return "directory";
	if (key === "g") return "global";
	return "session";
}

function isEscape(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.cancel");
}

function isEnter(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.confirm");
}
