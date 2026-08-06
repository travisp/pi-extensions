# Pi Stream Output

A small extension for showing live progress during Pi `--print` runs.

It writes status, tool calls, incremental tool output, and tool completion to stderr. Pi's final assistant response remains on stdout, so it is not duplicated and can still be redirected independently.

The extension is active only in print mode and has no effect on the interactive TUI. It is intentionally omitted from the repository's root Pi package manifest so it can be loaded explicitly by workflows that need it:

```bash
pi --no-extensions \
  --extension /path/to/extensions/stream-output/index.ts \
  --print "Do the task"
```

Inspired by [`yogibear54/my-own-pi-stuff`'s stream-output extension](https://github.com/yogibear54/my-own-pi-stuff/blob/main/extensions/stream-output/index.ts). This version streams progress rather than assistant text, avoiding a duplicate final response and terminal cursor-clearing tricks.
