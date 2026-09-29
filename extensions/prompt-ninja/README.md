# pi-prompt-ninja

Use `/prompt-ninja` to preview the effective system prompt and enable or disable individual sections and skill descriptions.

Settings are resolved from highest to lowest priority:

1. Session — stored in session entries.
2. Directory — `.pi/prompt-sections.json` in the current project.
3. Parent — ancestor `.pi/prompt-sections.json` files, with nearer parents taking precedence.
4. Global — `extensions/prompt-sections.json` under Pi's agent directory (`~/.pi/agent` by default).

Directory and parent files are read **only when `ctx.isProjectTrusted()` is true**. In untrusted projects, their columns are marked untrusted and directory editing is disabled; session and global settings still apply. Trust follows Pi's current session decision, including CLI overrides.

Targets Pi 0.99. Skills, project context, and appended instructions are filtered through Pi's structured prompt options. Intro, tools, rules, documentation, and cwd toggles use validated text filtering because Pi has no removal switches for those built-in sections. Hiding tool instructions never disables tools. Custom sections are preserved unless they override a section you disable.

If the prompt structure is unrecognized, malformed, or forced by an earlier extension, Prompt Ninja leaves both the prompt and its options unchanged and warns once per session. The preview remains available and displays “filtering unavailable.” Individual skill filtering also skips opaque custom skills-section overrides. Later extensions can still change the prompt after Prompt Ninja runs.

In the settings matrix, use arrow keys to select a row, `s`/`d`/`g` to cycle session/directory/global settings, Enter for detailed previews, and Escape to go back. Parent settings are read-only.

Example configuration:

```json
{
  "sections": {
    "piDocumentation": false
  }
}
```

Run regression tests from the repository root with `devbox run npm test`.
