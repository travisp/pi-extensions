interface ToolRow {
	result: { isError?: boolean };
	toolDefinition?: { renderShell?: string };
}

export function installRenderPatch(
	prototype: { render(width: number): string[] },
	options: {
		estimateResult(content: unknown): number;
		format(text: string, width: number, row: ToolRow): string;
	},
): () => void;
