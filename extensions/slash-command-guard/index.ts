import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

const BUILT_IN_COMMANDS = [
  "login",
  "logout",
  "model",
  "scoped-models",
  "settings",
  "resume",
  "new",
  "name",
  "session",
  "tree",
  "fork",
  "clone",
  "compact",
  "copy",
  "export",
  "share",
  "reload",
  "hotkeys",
  "changelog",
  "quit",
];

export default function slashCommandGuard(pi: ExtensionAPI) {
  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!event.text.startsWith("/")) return { action: "continue" };

    const parsed = parseSlashInput(event.text);
    if (!parsed) {
      ctx.ui.notify('Unknown slash command "/".', "error");
      return { action: "handled" };
    }

    const commands = getKnownCommandNames(pi);
    if (commands.has(parsed.command)) return { action: "continue" };

    const suggestion = findClosestCommand(parsed.command, commands);
    const message = suggestion
      ? `Unknown slash command "/${parsed.command}". Did you mean "/${suggestion}"?`
      : `Unknown slash command "/${parsed.command}".`;

    ctx.ui.notify(message, "error");
    return { action: "handled" };
  });
}

function parseSlashInput(text: string): { command: string; rest: string } | undefined {
  const match = text.match(/^\/([^\s]*)(.*)$/s);
  if (!match || !match[1]) return undefined;
  return { command: match[1], rest: match[2] ?? "" };
}

function getKnownCommandNames(pi: ExtensionAPI): Set<string> {
  const commands = new Set(BUILT_IN_COMMANDS);

  for (const command of pi.getCommands() as SlashCommandInfo[]) {
    commands.add(command.name);
  }

  return commands;
}

function findClosestCommand(input: string, commands: Set<string>): string | undefined {
  let best: { command: string; distance: number } | undefined;

  for (const command of commands) {
    const distance = levenshtein(input, command);
    if (!best || distance < best.distance || (distance === best.distance && command < best.command)) {
      best = { command, distance };
    }
  }

  if (!best) return undefined;

  const threshold = Math.max(2, Math.floor(Math.max(input.length, best.command.length) * 0.4));
  return best.distance <= threshold ? best.command : undefined;
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }

    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }

  return previous[b.length];
}
