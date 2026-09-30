import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
	createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
	ToolExecutionComponent, initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// Loaded by the integration harness through Pi's own loader, so these imports
// resolve to the same components as the extension, even in bundled builds.
export default function (pi) {
	initTheme();
	pi.registerCommand("context-render-test", {
		handler: async (_args, ctx) => {
			const definitions = [
				createReadToolDefinition(ctx.cwd), createWriteToolDefinition(ctx.cwd),
				createEditToolDefinition(ctx.cwd), createBashToolDefinition(ctx.cwd), ctx.codemode,
			];
			const argumentsByTool = {
				read: { path: "example.ts" },
				write: { path: "example.ts", content: "x".repeat(800) },
				edit: { path: "example.ts", edits: [{ oldText: "before", newText: "after" }] },
				bash: { command: "echo hello" },
				codemode: { code: 'text("hello")' },
			};

			for (const definition of definitions) {
				const name = definition.name;
				// Start with empty arguments to avoid edit's asynchronous file preview.
				const row = new ToolExecutionComponent(name, `${name}-test`, {}, {}, definition, { requestRender() {} }, ctx.cwd);
				row.args = argumentsByTool[name];
				if (name === "bash") Object.assign(row.rendererState, { startedAt: 0, endedAt: 1000 });
				const result = {
					content: [{ type: "text", text: "x".repeat(12000) }],
					details: name === "codemode" ? { calls: [] } : undefined,
				};
				const before = JSON.stringify(result);
				row.updateResult(result, false);

				for (const width of [20, 80, 120]) {
					const lines = row.render(width);
					const plain = lines.map(stripVTControlCharacters).join("\n");
					if (width >= 80) assert.equal(plain.match(/context tokens/g).length, 1, name);
					else assert.match(plain, /~[0-9,]+/, `${name} narrow annotation`);
					assert.ok(lines.every((line) => visibleWidth(line) <= width), `${name} width ${width}`);
					if (name === "bash" && width >= 80) assert.match(plain, /Took 1.0s · ~[\d,]+ context tokens/);
					if (name === "codemode") {
						assert.ok(row.resultRendererComponent.render(width - 2).length <= 17, "collapse fix remains bounded");
						const patch = ToolExecutionComponent.prototype[Symbol.for("travis.tool-context-usage.render-patch.v1")];
						assert.equal(lines.length, patch.original.call(row, width).length + 1, "one footer outside bounded output");
					}
				}

				row.setExpanded(true);
				const expanded = row.render(120).map(stripVTControlCharacters).join("\n");
				assert.match(expanded, /args ~[\d,]+ · result ~[\d,]+/, name);
				assert.equal(JSON.stringify(result), before, "result unchanged");
				ctx.rows.push(row);
			}
		},
	});
}
