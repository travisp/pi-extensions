import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi does not expose built-in interactive slash commands through pi.getCommands().
// Keep this list in sync with Pi using `npm run check:builtins`.
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
  "import",
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

    const commandMatch = event.text.match(/^\/(\S+)/);
    if (!commandMatch) {
      // The input starts with "/" but has no command name, like "/" or "/   ".
      ctx.ui.notify('Unknown slash command "/".', "error");
      return { action: "handled" };
    }

    const command = commandMatch[1];
    const commands = getKnownCommandNames(pi);
    // Registered extension commands are handled before input hooks run, but prompt
    // templates and skills are expanded after input hooks. Let known commands continue
    // so Pi can handle or expand them in its normal flow.
    if (commands.has(command)) return { action: "continue" };

    const suggestion = findClosestCommand(command, commands);
    const message = suggestion
      ? `Unknown slash command "/${command}". Did you mean "/${suggestion}"?`
      : `Unknown slash command "/${command}".`;

    ctx.ui.notify(message, "error");
    return { action: "handled" };
  });
}

function getKnownCommandNames(pi: ExtensionAPI): Set<string> {
  return new Set([
    ...BUILT_IN_COMMANDS,
    ...pi.getCommands().map((command) => command.name),
  ]);
}

function findClosestCommand(input: string, commands: Set<string>): string | undefined {
  let best: { command: string; distance: number } | undefined;

  for (const command of commands) {
    const distance = damerauLevenshtein(input, command);
    const isBetterMatch =
      !best || distance < best.distance || (distance === best.distance && command < best.command);

    if (isBetterMatch) best = { command, distance };
  }

  if (!best) return undefined;

  const threshold = Math.max(3, Math.ceil(Math.max(input.length, best.command.length) * 0.5));
  return best.distance <= threshold ? best.command : undefined;
}

function damerauLevenshtein(a: string, b: string): number {
  const distances = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1));

  for (let i = 0; i <= a.length; i++) distances[i][0] = i;
  for (let j = 0; j <= b.length; j++) distances[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] + substitutionCost,
      );

      const isAdjacentSwap = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
      if (isAdjacentSwap) {
        distances[i][j] = Math.min(distances[i][j], distances[i - 2][j - 2] + 1);
      }
    }
  }

  return distances[a.length][b.length];
}
