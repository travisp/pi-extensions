import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DefaultResourceLoader,
	formatSkillsForPrompt,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";

type SettingsScope = "session" | "directory" | "global";
type CellState = "unset" | "on" | "off";

type PromptSectionName = "intro" | "tools" | "guidelines" | "piDocumentation" | "appendSection" | "projectContext" | "skills" | "runtimeContext";

type SectionSettings = Record<PromptSectionName, boolean>;

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
	cellText?: (scope: SettingsScope) => string;
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
	fixedHeight?: () => number;
};

type SectionMarker = {
	name: PromptSectionName;
	start: number;
};

type PromptSection = SectionMarker & {
	end: number;
	text: string;
};

const PROMPT_SECTION_DEFINITIONS: Array<{ name: PromptSectionName; label: string; description: string }> = [
	{ name: "intro", label: "Intro", description: "Opening identity and role instructions." },
	{ name: "tools", label: "Tools", description: "Available tools list and tool-use instructions." },
	{ name: "guidelines", label: "Guidelines", description: "General operating guidelines." },
	{ name: "piDocumentation", label: "Pi documentation", description: "Pi's built-in documentation pointers." },
	{ name: "appendSection", label: "Append section", description: "Additional system prompt text appended by settings or runtime options." },
	{ name: "projectContext", label: "Project context", description: "Project context loaded by Pi." },
	{ name: "skills", label: "Skills section", description: "The generated prompt section that tells the model when skills are available." },
	{ name: "runtimeContext", label: "Runtime context", description: "Current date, working directory, and other runtime context." },
];

const DEFAULT_SECTIONS: SectionSettings = {
	intro: true,
	tools: true,
	guidelines: true,
	piDocumentation: true,
	appendSection: true,
	projectContext: true,
	skills: true,
	runtimeContext: true,
};

const CONFIG_FILE_NAME = "prompt-sections.json";
const APPEND_SYSTEM_FILE_NAME = "APPEND_SYSTEM.md";
const SESSION_SETTINGS_ENTRY_TYPE = "prompt-sections-settings";
const SCOPES: SettingsScope[] = ["session", "directory", "global"];
const SETTING_COLUMN_WIDTH = 30;
const EFFECTIVE_COLUMN_WIDTH = 14;
const SCOPE_COLUMN_WIDTH = 14;
const SETTINGS_MATRIX_FIXED_LINES = 34;
const FULL_PROMPT_VIEWER_FIXED_LINES = 5;
const SKILL_BLOCK_PATTERN = /  <skill>[\s\S]*?  <\/skill>/g;

let sessionConfig: PromptSectionsConfig = {};
let latestBaseSystemPrompt: string | undefined;
let latestAppendSystemPrompt: string | undefined;
let latestAppendScope: SettingsScope | undefined;

export default function promptSections(pi: ExtensionAPI) {
	pi.registerCommand("prompt-ninja", {
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
		latestAppendSystemPrompt = event.systemPromptOptions.appendSystemPrompt;
		latestAppendScope = detectAppendScope(event.systemPromptOptions.cwd, latestAppendSystemPrompt);

		const configs = loadScopedConfigs(event.systemPromptOptions.cwd);
		const skills = event.systemPromptOptions.skills ?? [];
		const nextSystemPrompt = effectiveSystemPrompt(event.systemPrompt, latestAppendSystemPrompt, configs, skills);

		return nextSystemPrompt === event.systemPrompt ? undefined : { systemPrompt: nextSystemPrompt };
	});
}

function splitSystemPrompt(systemPrompt: string, appendSystemPrompt?: string): PromptSection[] {
	const markers: SectionMarker[] = [];
	addMarker(markers, systemPrompt, "tools", "Available tools:");
	addMarker(markers, systemPrompt, "guidelines", "Guidelines:");
	addMarker(markers, systemPrompt, "piDocumentation", "Pi documentation");
	if (appendSystemPrompt) addMarker(markers, systemPrompt, "appendSection", appendSystemPrompt);
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

function addMarker(markers: SectionMarker[], text: string, name: PromptSectionName, marker: string): void {
	const start = sectionStart(text, marker);
	if (start !== -1) markers.push({ name, start });
}

function sectionStart(text: string, marker: string): number {
	if (text.startsWith(marker)) return 0;
	const index = text.indexOf(`\n\n${marker}`);
	return index === -1 ? -1 : index + 2;
}

function addRuntimeContextMarker(markers: SectionMarker[], text: string): void {
	const match = text.match(/\nCurrent date: .*\nCurrent working directory: .*$/);
	if (match?.index !== undefined) markers.push({ name: "runtimeContext", start: match.index + 1 });
}

function removeDisabledSections(systemPrompt: string, sections: PromptSection[], settings: SectionSettings): string {
	let nextPrompt = systemPrompt;
	for (const section of [...sections].reverse()) {
		if (!settings[section.name]) nextPrompt = removePromptRange(nextPrompt, section.start, section.end);
	}
	return nextPrompt;
}

function removePromptRange(systemPrompt: string, start: number, end: number): string {
	return [systemPrompt.slice(0, start).trimEnd(), systemPrompt.slice(end).trimStart()].filter(Boolean).join("\n\n");
}

function promptSectionText(name: PromptSectionName): string | undefined {
	if (!latestBaseSystemPrompt) return undefined;
	return splitSystemPrompt(latestBaseSystemPrompt, latestAppendSystemPrompt).find((section) => section.name === name)?.text;
}

function filterSkillsInPrompt(systemPrompt: string, skills: Skill[], allowedSkills: Set<string>): string {
	const currentSkillBlock = formatSkillsForPrompt(skills);
	if (!currentSkillBlock) return systemPrompt;
	if (allowedSkills.size === 0) return systemPrompt.replace(currentSkillBlock, "");

	const nextSkillBlock = formatSkillsForPrompt(configurableSkills(skills).filter((skill) => allowedSkills.has(skill.name)));
	return systemPrompt.replace(currentSkillBlock, nextSkillBlock);
}

async function showSettings(ctx: ExtensionCommandContext, pi: Pick<ExtensionAPI, "appendEntry">): Promise<void> {
	const resources = await loadPromptResources(ctx.cwd);
	latestAppendSystemPrompt = resources.appendSystemPrompt;
	latestAppendScope = resources.appendScope;

	const currentSystemPrompt = ctx.getSystemPrompt();
	const currentPromptSections = splitSystemPrompt(currentSystemPrompt, latestAppendSystemPrompt);
	let basePrompt = latestBaseSystemPrompt;
	if (!basePrompt || currentPromptSections.some((section) => section.name === "piDocumentation")) {
		basePrompt = currentSystemPrompt;
		latestBaseSystemPrompt = basePrompt;
	}

	const skills = resources.skills;
	const configs = loadScopedConfigs(ctx.cwd);
	const saveScope = (scope: SettingsScope) => saveScopedConfig(scope, ctx.cwd, configs[scope], pi);

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const matrixHeight = () => Math.max(8, Math.min(SETTINGS_MATRIX_FIXED_LINES, tui.terminal.rows - 4));
		const fullPageSize = () => Math.max(8, tui.terminal.rows - 4);
		const rows = mainRows(basePrompt, skills, configs, saveScope, theme, matrixHeight, fullPageSize);
		return createMatrix(rows, {
			title: "Prompt sections",
			theme,
			reset: () => resetAllSettings(configs, saveScope),
			done: () => done(undefined),
			fixedHeight: matrixHeight,
		});
	});
}

function mainRows(
	basePrompt: string,
	skills: Skill[],
	configs: ScopedConfigs,
	saveScope: (scope: SettingsScope) => void,
	theme: Theme,
	matrixHeight: () => number,
	fullPageSize: () => number,
): MatrixRow[] {
	const sectionRows = promptSectionRows(configs, saveScope);
	const skillInvocationRow: MatrixRow = {
		id: "skillInvocations",
		label: "Skill invocations in prompt",
		description: "Enter opens individual skills.",
		preview: () => promptSectionText("skills") ?? formatSkillsForPrompt(configurableSkills(skills)),
		effective: () => skillsSummary(skills, effectiveAllowedSkillNames(configs, skills)),
		cellText: (scope) => skillScopeSummaryForSkills(configs[scope], configurableSkills(skills)),
		open: (done) => createSkillsMatrix(skills, configs, saveScope, done, theme, matrixHeight),
	};
	const skillsRowIndex = sectionRows.findIndex((row) => row.id === "skills");
	sectionRows.splice(skillsRowIndex + 1, 0, skillInvocationRow);

	return [
		{
			id: "fullPrompt",
			label: "Full system prompt",
			description: "Enter opens the full effective system prompt preview. In preview, press p to hide or show disabled parts.",
			previewLines: (width) => fullSystemPromptPreviewLines(basePrompt, latestAppendSystemPrompt, configs, skills, width),
			previewLineLimit: 12,
			effective: () => "preview",
			open: (done) => createFullPromptViewer(
				(width, hideDisabledParts) => hideDisabledParts
					? enabledSystemPromptPreviewLines(basePrompt, latestAppendSystemPrompt, configs, skills, width)
					: fullSystemPromptPreviewLines(basePrompt, latestAppendSystemPrompt, configs, skills, width),
				theme,
				fullPageSize,
				done,
			),
		},
		...sectionRows,
	];
}

function promptSectionRows(configs: ScopedConfigs, saveScope: (scope: SettingsScope) => void): MatrixRow[] {
	return PROMPT_SECTION_DEFINITIONS.map((section) => ({
		id: section.name,
		label: section.label,
		description: section.description,
		preview: () => promptSectionText(section.name) ?? "",
		effective: () => section.name === "appendSection" ? appendEffective(configs) : onOff(resolveSection(configs, section.name)),
		cell: (scope) => sectionCell(configs[scope], section.name),
		cellText: section.name === "appendSection" ? (scope) => appendCellText(configs[scope], scope) : undefined,
		setCell: (scope, state) => {
			setSectionCell(configs[scope], section.name, state);
			saveScope(scope);
		},
	}));
}

function createSkillsMatrix(
	skills: Skill[],
	configs: ScopedConfigs,
	saveScope: (scope: SettingsScope) => void,
	done: () => void,
	theme: Theme,
	fixedHeight: () => number,
): Component {
	const availableSkills = configurableSkills(skills).sort((a, b) => a.name.localeCompare(b.name));
	const groupedRows = skillGroups(availableSkills).flatMap((group): MatrixRow[] => [
		{
			id: `__group:${group.id}`,
			label: group.label,
			description: group.description,
			preview: () => formatSkillsForPrompt(group.skills),
			effective: () => skillsSummary(group.skills, effectiveAllowedSkillNames(configs, skills)),
			cellText: (scope) => skillScopeSummaryForSkills(configs[scope], group.skills),
		},
		...group.skills.map((skill): MatrixRow => ({
			id: skill.name,
			label: `  ${skill.name}`,
			description: skill.description,
			preview: () => skillPromptBlock(skill),
			effective: () => onOff(effectiveSkillEnabled(configs, skill.name)),
			cell: (scope) => skillCell(configs[scope], skill.name),
			setCell: (scope, state) => {
				setSkillCell(configs[scope], skill.name, state);
				saveScope(scope);
			},
		})),
	]);
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
		...groupedRows,
	];

	return createMatrix(rows, {
		title: "Skill invocations in prompt",
		theme,
		reset: () => resetSkillSettings(configs, saveScope),
		done,
		search: true,
		fixedHeight,
	});
}

type SkillGroup = {
	id: string;
	label: string;
	description: string;
	skills: Skill[];
};

function skillGroups(skills: Skill[]): SkillGroup[] {
	const groups = new Map<string, SkillGroup>();
	for (const skill of skills) {
		const definition = skillGroupDefinition(skill);
		let group = groups.get(definition.id);
		if (!group) {
			group = { ...definition, skills: [] };
			groups.set(definition.id, group);
		}
		group.skills.push(skill);
	}

	return [...groups.values()].sort((a, b) => skillGroupSortOrder(a.id) - skillGroupSortOrder(b.id) || a.label.localeCompare(b.label));
}

function skillGroupDefinition(skill: Skill): Omit<SkillGroup, "skills"> {
	const scope = skill.sourceInfo.scope;
	if (scope === "user") {
		return {
			id: "global",
			label: "Global skills",
			description: "Summary of skills loaded from your global Pi configuration and globally installed Pi packages.",
		};
	}
	if (scope === "project") {
		return {
			id: "project",
			label: "Project skills",
			description: "Summary of skills loaded from this project, including .pi/skills and project-installed Pi packages.",
		};
	}
	return {
		id: "other",
		label: "Other skills",
		description: "Summary of skills loaded from explicit paths or temporary sources.",
	};
}

function skillGroupSortOrder(id: string): number {
	if (id === "project") return 0;
	if (id === "global") return 1;
	return 2;
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
			if (row && (row.preview || row.previewLines)) renderPreview(lines, row, width, options.theme);
			return fitLinesToHeight(lines, options.fixedHeight?.());
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

function createFullPromptViewer(
	linesForWidth: (width: number, hideDisabledParts: boolean) => string[],
	theme: Theme,
	pageSize: () => number,
	done: () => void,
): Component {
	let scroll = 0;
	let hideDisabledParts = false;
	const contentLineCount = () => Math.max(1, pageSize() - FULL_PROMPT_VIEWER_FIXED_LINES);

	return {
		render: (width) => {
			const contentLines = linesForWidth(width, hideDisabledParts);
			const visibleLineCount = contentLineCount();
			const pageCount = Math.max(1, Math.ceil(contentLines.length / visibleLineCount));
			const currentPage = Math.min(pageFromScroll(scroll, visibleLineCount), pageCount - 1);
			scroll = Math.min(scroll, Math.max(0, contentLines.length - 1));
			const visible = contentLines.slice(scroll, scroll + visibleLineCount);
			const filler = Array.from({ length: Math.max(0, visibleLineCount - visible.length) }, () => "");
			return [
				truncate(styleTitle(theme, "Full system prompt"), width),
				formatPreviewHeader(width, theme),
				...visible,
				...filler,
				truncate(`  Page ${currentPage + 1}/${pageCount} · ${hideDisabledParts ? "disabled hidden" : "disabled shown"}`, width),
				"",
				truncate("  ↑/↓ scroll · ←/→ page · p hide/show disabled · Esc back", width),
			];
		},
		handleInput: (data) => {
			const visibleLineCount = contentLineCount();
			if (isUp(data)) scroll = Math.max(0, scroll - 1);
			else if (isDown(data)) scroll++;
			else if (isLeft(data)) scroll = Math.max(0, (pageFromScroll(scroll, visibleLineCount) - 1) * visibleLineCount);
			else if (isRight(data)) scroll = (pageFromScroll(scroll, visibleLineCount) + 1) * visibleLineCount;
			else if (isPromptToggleKey(data)) {
				hideDisabledParts = !hideDisabledParts;
				scroll = 0;
			} else if (isEscape(data)) done();
		},
	};
}

function pageFromScroll(scroll: number, pageSize: number): number {
	return Math.floor(scroll / pageSize);
}

function fitLinesToHeight(lines: string[], height?: number): string[] {
	if (height === undefined) return lines;
	const target = Math.max(1, height);
	if (lines.length >= target) return lines.slice(0, target);
	return [...lines, ...Array.from({ length: target - lines.length }, () => "")];
}

function renderWrappedSection(lines: string[], text: string, width: number): void {
	lines.push("");
	for (const line of wrapTextWithAnsi(text, Math.max(1, width - 2))) {
		lines.push(truncate(`  ${line}`, width));
	}
}

function renderPreview(lines: string[], row: MatrixRow, width: number, theme: Theme): void {
	const allLines = row.previewLines ? row.previewLines(width) : plainPreviewLines(row.preview!(), width);
	if (allLines.length === 0) return;

	const maxLines = row.previewLineLimit ?? 12;
	const visibleLines = allLines.slice(0, maxLines);
	const rule = "─".repeat(Math.max(1, width));

	lines.push("", truncate(rule, width), truncate(theme.bold("Prompt preview"), width), truncate(rule, width));
	lines.push(...visibleLines);
	if (row.open && allLines.length > maxLines) lines.push(truncate("  Press Enter to open full preview.", width));
	lines.push(truncate(rule, width));
}

function fullSystemPromptPreviewLines(basePrompt: string, appendSystemPrompt: string | undefined, configs: ScopedConfigs, skills: Skill[], width: number): string[] {
	const sections = splitSystemPrompt(basePrompt, appendSystemPrompt);
	const allowedSkills = effectiveAllowedSkillNames(configs, skills);
	const allSkillsDisabled = configurableSkills(skills).length > 0 && allowedSkills.size === 0;
	const skillBlocks = allSkillsDisabled ? [] : skillPromptBlocks(sections.find((section) => section.name === "skills"), allowedSkills);
	return promptLinesWithOffsets(basePrompt).flatMap((line) => {
		const section = sectionForOffset(sections, line.start);
		const label = previewLabel(section, line.start, configs, skillBlocks, allSkillsDisabled);
		return previewLine(line.text, width, label);
	});
}

function enabledSystemPromptPreviewLines(basePrompt: string, appendSystemPrompt: string | undefined, configs: ScopedConfigs, skills: Skill[], width: number): string[] {
	return fullSystemPromptPreviewLines(effectiveSystemPrompt(basePrompt, appendSystemPrompt, configs, skills), appendSystemPrompt, configs, skills, width);
}

function effectiveSystemPrompt(basePrompt: string, appendSystemPrompt: string | undefined, configs: ScopedConfigs, skills: Skill[]): string {
	const promptWithSectionsRemoved = removeDisabledSections(basePrompt, splitSystemPrompt(basePrompt, appendSystemPrompt), resolvedSections(configs));
	return filterSkillsInPrompt(promptWithSectionsRemoved, skills, effectiveAllowedSkillNames(configs, skills));
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
	return sections.find((section) => offset >= section.start && offset < section.end);
}

function previewLabel(
	section: PromptSection | undefined,
	offset: number,
	configs: ScopedConfigs,
	skillBlocks: Array<{ start: number; end: number; label: string }>,
	allSkillsDisabled: boolean,
): string {
	if (!section) return "Prompt";
	if (section.name === "skills") {
		if (!resolveSection(configs, "skills") || allSkillsDisabled) return "S:Skills [disabled]";
		return skillBlocks.find((block) => offset >= block.start && offset < block.end)?.label ?? "S:Skills";
	}
	const label = sectionLabel(section.name);
	return resolveSection(configs, section.name) ? label : `${label} [disabled]`;
}

function skillPromptBlocks(section: PromptSection | undefined, allowedSkills: Set<string>): Array<{ start: number; end: number; label: string }> {
	if (!section) return [];
	const blocks: Array<{ start: number; end: number; label: string }> = [];
	for (const match of section.text.matchAll(SKILL_BLOCK_PATTERN)) {
		const skillName = match[0].match(/<name>(.*?)<\/name>/)![1];
		const start = section.start + match.index!;
		blocks.push({
			start,
			end: start + match[0].length,
			label: allowedSkills.has(skillName) ? `S:${skillName}` : `S:${skillName} [disabled]`,
		});
	}
	return blocks;
}

function skillPromptBlock(skill: Skill): string {
	return formatSkillsForPrompt([skill]).match(SKILL_BLOCK_PATTERN)![0].replace(/^  /gm, "");
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
	if (!text) return [formatPreviewLine(sectionLabel, "", labelWidth, width)];
	return wrapTextWithAnsi(text, textWidth).map((line) => formatPreviewLine(sectionLabel, line, labelWidth, width));
}

function formatPreviewLine(section: string, text: string, labelWidth: number, width: number): string {
	return truncate(`${pad(section, labelWidth)} │ ${text}`, width);
}

function previewLabelWidth(width: number): number {
	return Math.min(22, Math.max(10, Math.floor(width * 0.25)));
}

function formatPreviewHeader(width: number, theme: Theme): string {
	const labelWidth = previewLabelWidth(width);
	const textWidth = Math.max(1, width - labelWidth - 3);
	return truncate(theme.bold(`${pad("Section", labelWidth)} │ ${pad("Prompt", textWidth)}`), width);
}

function sectionLabel(name: PromptSectionName): string {
	if (name === "piDocumentation") return "Pi docs";
	if (name === "appendSection") return "Append";
	if (name === "projectContext") return "Project context";
	if (name === "runtimeContext") return "Runtime";
	return name[0].toUpperCase() + name.slice(1);
}

function formatHeader(width: number, theme: Theme): string {
	return truncate(theme.bold(`  ${pad("Setting", SETTING_COLUMN_WIDTH)}  ${pad("Effective", EFFECTIVE_COLUMN_WIDTH)}  ${pad("Session", SCOPE_COLUMN_WIDTH)}  ${pad("Directory", SCOPE_COLUMN_WIDTH)}  ${pad("Global", SCOPE_COLUMN_WIDTH)}`), width);
}

function formatRow(row: MatrixRow, selected: boolean, width: number): string {
	const values = SCOPES.map((scope) => formatCell(row.cellText?.(scope) ?? row.cell?.(scope) ?? "unset"));
	const prefix = selected ? "▸ " : "  ";
	return truncate(`${prefix}${pad(row.label, SETTING_COLUMN_WIDTH)}  ${pad(row.effective(), EFFECTIVE_COLUMN_WIDTH)}  ${values.join("  ")}`, width);
}

function formatCell(value: CellState | string): string {
	return pad(value === "unset" || value === "" ? "—" : value, SCOPE_COLUMN_WIDTH);
}

function appendEffective(configs: ScopedConfigs): string {
	if (!resolveSection(configs, "appendSection")) return "off";
	return latestAppendSystemPrompt ? "active" : "inactive";
}

function appendCellText(config: PromptSectionsConfig, scope: SettingsScope): string {
	const state = sectionCell(config, "appendSection");
	if (latestAppendScope !== scope) return state;
	return state === "unset" ? "active" : `active/${state}`;
}

function pad(text: string, width: number): string {
	const value = truncate(text, width);
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function truncate(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "");
}

function styleTitle(theme: Theme, title: string): string {
	return theme.fg("accent", theme.bold(title));
}

function nextCellState(current: CellState): CellState {
	if (current === "unset") return "off";
	if (current === "off") return "on";
	return "unset";
}

function sectionCell(config: PromptSectionsConfig, section: keyof SectionSettings): CellState {
	const sections = config.sections;
	if (!hasOwn(sections, section)) return "unset";
	return sections[section] ? "on" : "off";
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
	const settings = config.skills;
	if (!hasOwn(settings, "default")) return "unset";
	return settings.default ? "on" : "off";
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

	const settings = config.skills;
	if (!hasOwn(settings, "default")) return "unset";
	return settings.default ? "on" : "off";
}

function effectiveAllowedSkillNames(configs: ScopedConfigs, skills: Skill[]): Set<string> {
	return new Set(configurableSkills(skills)
		.filter((skill) => effectiveSkillEnabled(configs, skill.name))
		.map((skill) => skill.name));
}

function skillsSummary(skills: Skill[], allowedSkills: Set<string>): string {
	const skillNames = configurableSkills(skills).map((skill) => skill.name);
	const visibleCount = skillNames.filter((name) => allowedSkills.has(name)).length;
	return `${visibleCount}/${skillNames.length} visible`;
}

function skillScopeSummaryForSkills(config: PromptSectionsConfig, skills: Skill[]): string {
	const settings = config.skills;
	if (!settings) return "";

	const skillNames = new Set(skills.map((skill) => skill.name));
	const allowCount = (settings.allow ?? []).filter((name) => skillNames.has(name)).length;
	const denyCount = (settings.deny ?? []).filter((name) => skillNames.has(name)).length;
	return formatSkillScopeSummary(settings, allowCount, denyCount);
}

function formatSkillScopeSummary(settings: SkillSettings, allowCount: number, denyCount: number): string {
	if (settings.default === true) return denyCount > 0 ? `all on/${denyCount} off` : "all on";
	if (settings.default === false) return allowCount > 0 ? `all off/${allowCount} on` : "all off";
	if (allowCount > 0 && denyCount > 0) return `${allowCount} on/${denyCount} off`;
	if (allowCount > 0) return `${allowCount} on`;
	if (denyCount > 0) return `${denyCount} off`;
	return "";
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

function resolvedSections(configs: ScopedConfigs): SectionSettings {
	return Object.fromEntries(
		PROMPT_SECTION_DEFINITIONS.map((section) => [section.name, resolveSection(configs, section.name)]),
	) as SectionSettings;
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

async function loadPromptResources(cwd: string): Promise<{ skills: Skill[]; appendSystemPrompt?: string; appendScope?: SettingsScope }> {
	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
	await resourceLoader.reload();
	const appendPrompts = resourceLoader.getAppendSystemPrompt();
	const appendSystemPrompt = appendPrompts.length > 0 ? appendPrompts.join("\n\n") : undefined;
	return {
		skills: resourceLoader.getSkills().skills,
		appendSystemPrompt,
		appendScope: detectAppendScope(cwd, appendSystemPrompt),
	};
}

function detectAppendScope(cwd: string, appendSystemPrompt: string | undefined): SettingsScope | undefined {
	if (!appendSystemPrompt) return undefined;
	if (existsSync(directoryAppendPath(cwd))) return "directory";
	if (existsSync(globalAppendPath())) return "global";
	return undefined;
}

function globalConfigPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

function directoryConfigPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_FILE_NAME);
}

function globalAppendPath(): string {
	return join(getAgentDir(), APPEND_SYSTEM_FILE_NAME);
}

function directoryAppendPath(cwd: string): string {
	return join(cwd, ".pi", APPEND_SYSTEM_FILE_NAME);
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

function hasOwn<T extends object, K extends PropertyKey>(object: T | undefined, key: K): object is T & Record<K, unknown> {
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

function isPromptToggleKey(data: string): boolean {
	return data.toLowerCase() === "p";
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
