import { stripVTControlCharacters } from "node:util";

const patchKey = Symbol.for("travis.tool-context-usage.render-patch.v1");
const tools = new Set(["read", "bash", "write", "edit", "codemode"]);

/** Decorate completed tool rows without registering tools or changing their results. */
export function installRenderPatch(prototype, options) {
	let patch = prototype[patchKey];
	if (!patch) {
		const original = prototype.render;
		// Leases let overlapping reloads share one wrapper without double decoration.
		patch = { original, leases: new Map() };
		patch.render = function (width) {
			const lines = original.call(this, width);
			if (!patch.leases.size || !tools.has(this.toolName) || this.isPartial || !lines.length) return lines;
			const { estimateResult, format } = [...patch.leases.values()].at(-1);
			const input = Math.ceil((this.toolName.length + JSON.stringify(this.args).length) / 4);
			const result = estimateResult(this.result.content);
			const label = `~${(input + result).toLocaleString("en-US")} context tokens` +
				(this.expanded ? ` (args ~${input.toLocaleString("en-US")} · result ~${result.toLocaleString("en-US")})` : "");
			const output = [...lines];
			// Bash's timing is the last nonblank row. Require its timing state so output
			// that happens to say "Took ..." is not mistaken for a renderer footer.
			const timingIndex = this.toolName === "bash" && this.rendererState.startedAt !== undefined
				? output.findLastIndex((line) => stripVTControlCharacters(line).trim()) : -1;
			if (timingIndex !== -1) {
				const timing = stripVTControlCharacters(output[timingIndex]).trim();
				if (/^Took \d/.test(timing)) {
					output[timingIndex] = format(` ${timing} · ${label}`, width, this);
					return output;
				}
			}
			// Default boxes end with a padding row; self-framed renderers do not.
			const insertion = this.toolDefinition?.renderShell === "self" ? output.length : output.length - 1;
			output.splice(insertion, 0, format(` ${label}`, width, this));
			return output;
		};
		prototype[patchKey] = patch;
		prototype.render = patch.render;
	}
	const lease = Symbol();
	patch.leases.set(lease, options);
	return () => {
		patch.leases.delete(lease);
		if (!patch.leases.size && prototype.render === patch.render) {
			prototype.render = patch.original;
			delete prototype[patchKey];
		}
		// If another patch wraps ours, leave its chain intact. Our empty lease makes ours inert.
	};
}
