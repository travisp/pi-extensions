import { readFile } from "node:fs/promises";

const localCommands = await readLocalBuiltInCommands();
const piCommands = await readPiBuiltInCommands();

const localCommandSet = new Set(localCommands);
const piCommandSet = new Set(piCommands);
const missing = piCommands.filter((command) => !localCommandSet.has(command));
const extra = localCommands.filter((command) => !piCommandSet.has(command));

if (missing.length || extra.length) {
  console.error("Built-in slash command list is out of sync with Pi.");
  if (missing.length) console.error(`Missing from index.ts: ${formatCommands(missing)}`);
  if (extra.length) console.error(`Not present in Pi: ${formatCommands(extra)}`);
  process.exitCode = 1;
} else {
  console.log(`Built-in slash command list matches Pi (${piCommands.length} commands).`);
}

async function readLocalBuiltInCommands() {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const match = source.match(/const\s+BUILT_IN_COMMANDS\s*=\s*\[([\s\S]*?)\];/);
  if (!match) throw new Error("Could not find BUILT_IN_COMMANDS in index.ts");

  return Array.from(match[1].matchAll(/"([^"]+)"/g), ([, command]) => command);
}

async function readPiBuiltInCommands() {
  const piIndexUrl = await import.meta.resolve("@earendil-works/pi-coding-agent");
  const slashCommandsUrl = new URL("./core/slash-commands.js", piIndexUrl);
  const { BUILTIN_SLASH_COMMANDS } = await import(slashCommandsUrl.href);

  return BUILTIN_SLASH_COMMANDS.map((command) => command.name);
}

function formatCommands(commands) {
  return commands.map((command) => `/${command}`).join(", ");
}
