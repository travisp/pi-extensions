declare module "@earendil-works/pi-coding-agent" {
  export interface ToolCallEvent {
    toolName: string;
    input: Record<string, unknown>;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    ui: {
      select(message: string, choices: string[]): Promise<string>;
    };
  }

  export interface SlashCommandInfo {
    name: string;
  }

  export interface ExtensionAPI {
    getCommands(): SlashCommandInfo[];
    on(
      eventName: "tool_call",
      handler: (event: ToolCallEvent, ctx: ExtensionContext) => unknown | Promise<unknown>,
    ): void;
  }
}
