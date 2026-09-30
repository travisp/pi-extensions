# Tool context usage (experimental)

Adds estimated context tokens to completed read, bash, write, edit, and codemode boxes. Includes tool name, serialized arguments, and returned content, using Pi's approximate characters/4 accounting and its image allowance. Excludes UI-only details and nested outputs not returned by codemode. Counts original context added, not what remains after compaction or request-local context transformations.

**No tool registrations or execution changes.** Patches the exported `ToolExecutionComponent.prototype.render` and reads its internal fields. Tested with Pi 0.99.1, including bundled extension imports. Those fields and layout are not a supported extension contract; test again after Pi upgrades.

## Try it

From this repository:

```sh
pi -e ./extensions/tool-context-usage/index.ts
```

The root package loads this extension automatically. If it is already installed, use `/reload` rather than also loading it with `-e`.

Keep your existing codemode-collapse-fix loaded. Estimates appear outside its bounded output.

Use `/tool-context-usage` to show the current setting, `/tool-context-usage off` to hide estimates, and `/tool-context-usage on` to show them again. Changes apply immediately, including existing tool boxes. The setting defaults to on and persists globally in `~/.pi/agent/extensions/tool-context-usage.json` (under your configured Pi agent directory).

Expand a tool to see the arguments/result breakdown. Bash extends its final timing row; other tools get a footer. Narrow terminals truncate the annotation.

There is no SSH-specific handling: rendering decorates the final tool box regardless of which extension owns execution.

Turning it off or shutting down releases the patch; cleanup restores the prior method only if no later extension has replaced it. When another patch wraps ours, ours becomes inert rather than undoing that patch. An extension that replaces render without delegating can still prevent annotations.

## Tests

```sh
devbox run -- node --test test/tool-context-usage.test.mjs
devbox run -- node extensions/tool-context-usage/integration-test.mjs
```

Integration tests require an available Pi package. Set `PI_TEST_AGENT_ENTRY` to an installed `dist/index.js`, or to the bundled chunk exporting `discoverAndLoadExtensions`, to test that build without installing dependencies. The harness loads both extensions, constructs real tool boxes, and checks collapse behavior, expansion, widths, unchanged results, and cleanup. It never executes tools.

Live fullscreen/regular-terminal testing, visual theme checks, and other prototype-patching extensions still need manual verification.
