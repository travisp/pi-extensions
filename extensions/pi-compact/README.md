# pi-compact

Removes the single blank spacer row above Pi's input editor. Notifications and other widgets remain visible. Loading the extension enables it automatically in terminal mode; RPC and print modes are unaffected.

```bash
pi install /path/to/pi-extensions/extensions/pi-compact
```

This patches only the above-editor container in memory, without editing Pi's files. It handles widget rebuilds and restores the spacer when unloaded. Regular and fullscreen modes share the patched container.

The patch relies on Pi's internal layout, verified against Pi 1.1.0. If the expected container or spacer is missing, it leaves the layout unchanged and shows a warning. It does not remove unused fullscreen transcript space or spacing inside messages.
