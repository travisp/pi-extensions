import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keep recognizing the original type so older snapshots stay filtered and deduped.
const LEGACY_CUSTOM_TYPE = "system-prompt-display";
const INITIAL_CUSTOM_TYPE = "initial-system-prompt";
const CHANGED_CUSTOM_TYPE = "system-prompt-changed";

type WritableSessionManager = {
  appendCustomEntry(customType: string, data?: unknown): string;
};

export default function systemPromptDisplay(pi: ExtensionAPI) {
  let lastPrompt: string | undefined;

  const restoreLastPrompt = (ctx: { sessionManager: { getBranch(): unknown[] } }) => {
    lastPrompt = undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      const prompt = promptFromEntry(entry);
      if (prompt !== undefined) lastPrompt = prompt;
    }
  };

  pi.on("session_start", (_event, ctx) => restoreLastPrompt(ctx));
  pi.on("session_tree", (_event, ctx) => restoreLastPrompt(ctx));

  // Older versions used custom_message entries, which participate in future LLM
  // context by default. New snapshots use custom entries, which Pi excludes from
  // LLM context even when this extension is not installed.
  //
  // Keep filtering old custom_message snapshots while the extension is installed.
  pi.on("context", (event) => {
    const messages = event.messages.filter((message) => {
      if (message.role !== "custom") return true;
      return !isSystemPromptCustomType(message.customType);
    });

    if (messages.length === event.messages.length) return undefined;
    return { messages };
  });

  pi.on("before_provider_request", (_event, ctx) => {
    const prompt = ctx.getSystemPrompt();
    if (prompt === lastPrompt) return undefined;

    try {
      const customType = lastPrompt === undefined ? INITIAL_CUSTOM_TYPE : CHANGED_CUSTOM_TYPE;
      const sessionManager = ctx.sessionManager as unknown as WritableSessionManager;
      sessionManager.appendCustomEntry(customType, prompt);
      lastPrompt = prompt;
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`system-prompt-display: failed to record system prompt: ${message}`, "warning");
      }
    }
  });
}

function promptFromEntry(entry: unknown): string | undefined {
  if (!isCustomTypedEntry(entry)) return undefined;
  if (!isSystemPromptCustomType(entry.customType)) return undefined;

  if (entry.type === "custom" && typeof entry.data === "string") return entry.data;
  if (entry.type === "custom_message" && typeof entry.content === "string") return entry.content;

  return undefined;
}

function isCustomTypedEntry(entry: unknown): entry is {
  type?: unknown;
  customType: string;
  data?: unknown;
  content?: unknown;
} {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "customType" in entry &&
    typeof entry.customType === "string"
  );
}

function isSystemPromptCustomType(customType: string) {
  return (
    customType === INITIAL_CUSTOM_TYPE ||
    customType === CHANGED_CUSTOM_TYPE ||
    customType === LEGACY_CUSTOM_TYPE
  );
}

