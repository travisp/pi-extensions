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
	preview?: () => string;
	previewLines?: (width: number) => string[];
	previewLineLimit?: number;
	effective: () => string;
	cell?: (scope: SettingsScope) => CellState;
	setCell?: (scope: SettingsScope, state: CellState) => void;
	open?: (done: () => void) => Component;
};

type Theme = {
	bold: (text: string) => string;
	fg: (color: string, text: string) => string;
};

type MatrixOptions = {
	title: string;
	theme: Theme;
	done: () => void;
	reset: () => void;
	search?: boolean;
};

type PromptSectionName = "intro" | "tools" | "guidelines" | "piDocumentation" | "appendSection" | "projectContext" | "skills" | "runtimeContext";

type PromptSection = {
	name: PromptSectionName;
	start: number;
	end: number;
	text: string;
};

const DEFAULT_SECTIONS: SectionSettings = {
	// Match Pi's normal behavior unless the user disables this section.
	piDocumentation: true,
};

const CONFIG_FILE_NAME = "prompt-sections.json";
const SESSION_SETTINGS_ENTRY_TYPE = "prompt-sections-settings";
const SCOPES: SettingsScope[] = ["session", "directory", "global"];

let sessionConfig: PromptSectionsConfig = {};
let latestBaseSystemPrompt: string | undefined;

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
		latestBaseSystemPrompt = event.systemPrompt;
		const promptSections = splitSystemPrompt(event.systemPrompt, event.systemPromptOptions);
		const sections = effectiveSections(event.systemPromptOptions.cwd);

		if (event.systemPromptOptions.customPrompt || sections.piDocumentation) {
			return filterSkillsInExistingPrompt(event.systemPrompt, event.systemPromptOptions);
		}

		const withoutDocs = removePromptSection(event.systemPrompt, promptSections, "piDocumentation");
		const filtered = filterSkillsInExistingPrompt(withoutDocs, event.systemPromptOptions);
		return filtered ?? { systemPrompt: withoutDocs };
	});
}

function splitSystemPrompt(systemPrompt: string, options?: BuildSystemPromptOptions): PromptSection[] {
	const markers: Array<{ name: PromptSectionName; start: number }> = [];
	addMarker(markers, systemPrompt, "tools", "Available tools:");
	addMarker(markers, systemPrompt, "guidelines", "Guidelines:");
	addMarker(markers, systemPrompt, "piDocumentation", "Pi documentation");
	if (options?.appendSystemPrompt) addMarker(markers, systemPrompt, "appendSection", options.appendSystemPrompt);
	addMarker(markers, systemPrompt, "projectContext", "# Project Context");
	addMarker(markers, systemPrompt, "skills", "The following skills provide specialized instructions for specific tasks.");
	addRuntimeContextMarker(markers, systemPrompt);

	markers.sort((a, b) => a.start - b.start);
	if (markers[0]?.start !== 0) markers.unshift({ name: "intro", start: 0 });

	return markers.map((marker, index) => {
		const end = markers[index + 1]?.start ?? systemPrompt.length;
		return {
			name: marker.name,
			start: marker.start,
			end,
			text: systemPrompt.slice(marker.start, end),
		};
	}).filter((section) => section.text.trim().length > 0);
}

function addMarker(markers: Array<{ name: PromptSectionName; start: number }>, text: string, name: PromptSectionName, marker: string): void {
	const start = sectionStart(text, marker);
	if (start !== -1) markers.push({ name, start });
}

function sectionStart(text: string, marker: string): number {
	if (text.startsWith(marker)) return 0;
	const index = text.indexOf(`\n\n${marker}`);
	return index === -1 ? -1 : index + 2;
}

function addRuntimeContextMarker(markers: Array<{ name: PromptSectionName; start: number }>, text: string): void {
	const match = text.match(/\nCurrent date: .*\nCurrent working directory: .*$/);
	if (match?.index !== undefined) markers.push({ name: "runtimeContext", start: match.index + 1 });
}

function removePromptSection(systemPrompt: string, sections: PromptSection[], name: PromptSectionName): string {
	const section = sections.find((candidate) => candidate.name === name);
	if (!section) return systemPrompt;
	return `${systemPrompt.slice(0, section.start).trimEnd()}\n\n${systemPrompt.slice(section.end).trimStart()}`;
}

function promptSectionText(name: PromptSectionName): string | undefined {
	return latestBaseSystemPrompt ? splitSystemPrompt(latestBaseSystemPrompt).find((section) => section.name === name)?.text : undefined;
}

function filterSkillsInExistingPrompt(systemPrompt: string, options: BuildSystemPromptOptions) {
	const skills = options.skills ?? [];
	const nextPrompt = filterSkillsInPrompt(systemPrompt, skills, effectiveAllowedSkillNames(loadScopedConfigs(options.cwd), skills));
	return nextPrompt === systemPrompt ? undefined : { systemPrompt: nextPrompt };
}

function filterSkillsInPrompt(systemPrompt: string, skills: Skill[], allowedSkills: Set<string>): string {
	const currentSkillBlock = formatSkillsForPrompt(skills);
	if (!currentSkillBlock) return systemPrompt;
	const nextSkillBlock = formatSkillsForPrompt(configurableSkills(skills).filter((skill) => allowedSkills.has(skill.name)));
	return systemPrompt.replace(currentSkillBlock, nextSkillBlock);
}

async function showSettings(ctx: ExtensionCommandContext, pi: Pick<ExtensionAPI, "appendEntry">): Promise<void> {
	const currentSystemPrompt = ctx.getSystemPrompt();
	const currentPromptSections = splitSystemPrompt(currentSystemPrompt);
	if (!latestBaseSystemPrompt || currentPromptSections.some((section) => section.name === "piDocumentation")) {
		latestBaseSystemPrompt = currentSystemPrompt;
	}

	const skills = await loadSkills(ctx.cwd);
	const configs = loadScopedConfigs(ctx.cwd);
	const saveScope = (scope: SettingsScope) => saveScopedConfig(scope, ctx.cwd, configs[scope], pi);

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const fullPageSize = () => Math.max(8, tui.terminal.rows - 4);
		const rows = mainRows(skills, configs, saveScope, theme, fullPageSize);
		return createMatrix(rows, {
			title: "Prompt sections",
			theme,
			reset: () => resetAllSettings(configs, saveScope),
			done: () => done(undefined),
		});
	});
}

function mainRows(
	skills: Skill[],
	configs: ScopedConfigs,
	saveScope: (scope: SettingsScope) => void,
	theme: Theme,
	fullPageSize: () => number,
): MatrixRow[] {
	const basePrompt = latestBaseSystemPrompt ?? "";
	return [
		{
			id: "fullPrompt",
			label: "Full system prompt",
			description: "Enter opens the full effective system prompt preview.",
			previewLines: (width) => fullSystemPromptPreviewLines(basePrompt, configs, skills, width),
			previewLineLimit: 12,
			effective: () => "preview",
			open: (done) => createPromptViewer("Full system prompt", (width) => fullSystemPromptPreviewLines(basePrompt, configs, skills, width), theme, fullPageSize, done),
		},
		{
			id: "piDocumentation",
			label: "Pi documentation",
			description: "Include Pi's built-in documentation pointers in the system prompt.",
			preview: () => promptSectionText("piDocumentation") ?? "",
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
			preview: () => promptSectionText("skills") ?? formatSkillsForPrompt(configurableSkills(skills)),
			effective: () => skillsSummary(skills, effectiveAllowedSkillNames(configs, skills)),
			open: (done) => createSkillsMatrix(skills, configs, saveScope, done, theme),
		},
	];
}

function createSkillsMatrix(skills: Skill[], configs: ScopedConfigs, saveScope: (scope: SettingsScope) => void, done: () => void, theme: Theme): Component {
	const availableSkills = configurableSkills(skills).sort((a, b) => a.name.localeCompare(b.name));
	const rows: MatrixRow[] = [
		{
			id: "__all",
			label: "All skills",
			description: "Press s, d, or g to toggle all skills at that scope.",
			preview: () => promptSectionText("skills") ?? formatSkillsForPrompt(availableSkills),
			effective: () => skillsSummary(skills, effectiveAllowedSkillNames(configs, skills)),
			cell: (scope) => allSkillsCell(configs[scope]),
			setCell: (scope, state) => {
				setAllSkillsCell(configs[scope], state);
				saveScope(scope);
			},
		},
		...availableSkills.map((skill): MatrixRow => ({
			id: skill.name,
			label: skill.name,
			description: skill.description,
			preview: () => formatSkillsForPrompt([skill]),
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
		theme,
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
			if (row?.description) renderWrappedSection(lines, row.description, width);
			lines.push("", truncate(options.search
				? "  ↑/↓ row · s session · d directory · g global · r reset · Type search · Esc back"
				: "  ↑/↓ row · s session · d directory · g global · r reset · Esc close", width));
			if (row?.preview) renderPreview(lines, row, width, options.theme);
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

			const scope = scopeForKey(data);
			if (isUp(data)) selectedRow = selectedRow === 0 ? rowsNow.length - 1 : selectedRow - 1;
			else if (isDown(data)) selectedRow = selectedRow === rowsNow.length - 1 ? 0 : selectedRow + 1;
			else if (scope) toggleSelectedCell(scope);
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

function createPromptViewer(
	title: string,
	linesForWidth: (width: number) => string[],
	theme: Theme,
	pageSize: () => number,
	done: () => void,
): Component {
	let scroll = 0;
	const contentLineCount = () => Math.max(1, pageSize() - 5);

	return {
		render: (width) => {
			const contentLines = linesForWidth(width);
			const visibleLineCount = contentLineCount();
			const pageCount = Math.max(1, Math.ceil(contentLines.length / visibleLineCount));
			const currentPage = Math.min(pageFromScroll(scroll, visibleLineCount), pageCount - 1);
			scroll = Math.min(scroll, Math.max(0, contentLines.length - 1));
			const visible = contentLines.slice(scroll, scroll + visibleLineCount);
			const filler = Array.from({ length: Math.max(0, visibleLineCount - visible.length) }, () => "");
			return [
				truncate(styleTitle(theme, title), width),
				formatPreviewHeader(width, theme),
				...visible,
				...filler,
				truncate(`  Page ${currentPage + 1}/${pageCount}`, width),
				"",
				truncate("  ↑/↓ scroll · ←/→ page · Esc back", width),
			];
		},
		handleInput: (data) => {
			const visibleLineCount = contentLineCount();
			if (isUp(data)) scroll = Math.max(0, scroll - 1);
			else if (isDown(data)) scroll++;
			else if (isLeft(data)) scroll = Math.max(0, (pageFromScroll(scroll, visibleLineCount) - 1) * visibleLineCount);
			else if (isRight(data)) scroll = (pageFromScroll(scroll, visibleLineCount) + 1) * visibleLineCount;
			else if (isEscape(data)) done();
		},
	};
}

function pageFromScroll(scroll: number, pageSize: number): number {
	return Math.floor(scroll / pageSize);
}

function renderWrappedSection(lines: string[], text: string, width: number): void {
	lines.push("");
	for (const line of wrapTextWithAnsi(text, Math.max(1, width - 2))) {
		lines.push(truncate(`  ${line}`, width));
	}
}

function renderPreview(lines: string[], row: MatrixRow, width: number, theme: Theme): void {
	const allLines = row.previewLines?.(width) ?? plainPreviewLines(row.preview?.() ?? "", width);
	if (allLines.length === 0) return;

	const maxLines = row.previewLineLimit ?? 12;
	const visibleLines = allLines.slice(0, maxLines);
	const rule = "─".repeat(Math.max(1, width));

	lines.push("", truncate(rule, width), truncate(boldText(theme, "Prompt preview"), width), truncate(rule, width));
	lines.push(...visibleLines);
	if (row.open && allLines.length > maxLines) lines.push(truncate("  Press Enter to open full preview.", width));
	lines.push(truncate(rule, width));
}

function fullSystemPromptPreviewLines(basePrompt: string, configs: ScopedConfigs, skills: Skill[], width: number): string[] {
	const sections = splitSystemPrompt(basePrompt);
	const allowedSkills = effectiveAllowedSkillNames(configs, skills);
	const skillBlocks = skillPromptBlocks(sections.find((section) => section.name === "skills"), allowedSkills);
	return promptLinesWithOffsets(basePrompt).flatMap((line) => {
		const section = sectionForOffset(sections, line.start);
		const label = previewLabel(section, line.start, configs, skillBlocks);
		return previewLine(line.text, width, label);
	});
}

function promptLinesWithOffsets(text: string): Array<{ text: string; start: number }> {
	const lines: Array<{ text: string; start: number }> = [];
	let start = 0;
	for (const line of text.split("\n")) {
		lines.push({ text: line, start });
		start += line.length + 1;
	}
	return lines;
}

function sectionForOffset(sections: PromptSection[], offset: number): PromptSection | undefined {
	return sections.find((section) => offset >= section.start && offset < section.end) ?? sections.at(-1);
}

function previewLabel(
	section: PromptSection | undefined,
	offset: number,
	configs: ScopedConfigs,
	skillBlocks: Array<{ start: number; end: number; label: string }>,
): string {
	if (!section) return "Prompt";
	if (section.name === "piDocumentation" && !resolveSection(configs, "piDocumentation")) return "Pi docs [disabled]";
	if (section.name === "skills") return skillBlocks.find((block) => offset >= block.start && offset < block.end)?.label ?? "S:Skills";
	return sectionLabel(section.name);
}

function skillPromptBlocks(section: PromptSection | undefined, allowedSkills: Set<string>): Array<{ start: number; end: number; label: string }> {
	if (!section) return [];
	const blocks: Array<{ start: number; end: number; label: string }> = [];
	const skillBlock = /  <skill>[\s\S]*?  <\/skill>/g;
	for (const match of section.text.matchAll(skillBlock)) {
		const skillName = match[0].match(/<name>(.*?)<\/name>/)?.[1] ?? "Skill";
		const start = section.start + (match.index ?? 0);
		blocks.push({
			start,
			end: start + match[0].length,
			label: allowedSkills.has(skillName) ? `S:${skillName}` : `S:${skillName} [disabled]`,
		});
	}
	return blocks;
}

function plainPreviewLines(text: string, width: number): string[] {
	if (text.length === 0) return [];
	const lines: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (!rawLine) {
			lines.push("");
			continue;
		}
		for (const line of wrapTextWithAnsi(rawLine, Math.max(1, width - 2))) {
			lines.push(truncate(`  ${line}`, width));
		}
	}
	return lines;
}

function previewLine(text: string, width: number, sectionLabel: string): string[] {
	const labelWidth = previewLabelWidth(width);
	const textWidth = Math.max(1, width - labelWidth - 3);
	if (!text) return [formatPreviewLine(sectionLabel, "", labelWidth, textWidth, width)];
	return wrapTextWithAnsi(text, textWidth).map((line) => formatPreviewLine(sectionLabel, line, labelWidth, textWidth, width));
}

function formatPreviewLine(section: string, text: string, labelWidth: number, textWidth: number, width: number): string {
	return truncate(`${pad(section, labelWidth)} │ ${truncate(text, textWidth)}`, width);
}

function previewLabelWidth(width: number): number {
	return Math.min(22, Math.max(10, Math.floor(width * 0.25)));
}

function formatPreviewHeader(width: number, theme: Theme): string {
	const labelWidth = previewLabelWidth(width);
	const textWidth = Math.max(1, width - labelWidth - 3);
	return truncate(boldText(theme, `${pad("Section", labelWidth)} │ ${pad("Prompt", textWidth)}`), width);
}

function sectionLabel(name: PromptSectionName): string {
	if (name === "piDocumentation") return "Pi docs";
	if (name === "appendSection") return "Append";
	if (name === "projectContext") return "Project context";
	if (name === "runtimeContext") return "Runtime";
	return name[0].toUpperCase() + name.slice(1);
}

function formatHeader(width: number, theme: Theme): string {
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

function styleTitle(theme: Theme, title: string): string {
	return theme.fg("accent", boldText(theme, title));
}

function boldText(theme: Theme, text: string): string {
	return theme.bold(text);
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

function isLeft(data: string): boolean {
	return data === "\u001b[D" || getKeybindings().matches(data, "tui.editor.cursorLeft");
}

function isRight(data: string): boolean {
	return data === "\u001b[C" || getKeybindings().matches(data, "tui.editor.cursorRight");
}

function isResetKey(data: string): boolean {
	return data.toLowerCase() === "r";
}

function scopeForKey(data: string): SettingsScope | undefined {
	const key = data.toLowerCase();
	if (key === "s") return "session";
	if (key === "d") return "directory";
	if (key === "g") return "global";
	return undefined;
}

function isEscape(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.cancel");
}

function isEnter(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.confirm");
}
