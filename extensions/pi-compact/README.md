# pi-compact

Removes the single blank spacer row above Pi's input editor at every terminal size. When the terminal has **fewer than 40 rows**, it also removes vertical padding inside user-message and tool boxes and spacer rows between messages/tools. At 40 rows or more, normal message spacing returns automatically.

Notifications, horizontal padding, and paragraph breaks inside message text remain unchanged. Loading the extension enables it automatically in terminal mode; RPC and print modes are unaffected.

```bash
pi install /path/to/pi-extensions/extensions/pi-compact
```

This patches the above-editor and chat containers in memory, without editing Pi's files. It handles widget rebuilds, new messages, streaming updates, and terminal resizing, and restores original spacing when unloaded. Regular and fullscreen modes share the patched containers.

The patch relies on Pi's internal layout, verified against Pi 1.1.0. If an expected container or spacer is missing, it leaves that part of the layout unchanged and shows a warning. Headers, dialogs, custom message components, and unused fullscreen transcript space are not compacted.
