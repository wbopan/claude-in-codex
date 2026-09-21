import type { JsonObject, JsonValue } from "@codexhost/shared-contracts";

/** Client-owned MCP definitions and execution. The Harness retains its native tool permissions. */
export interface HarnessClientTool {
  namespace: string;
  definition: JsonObject;
}

export type HarnessClientToolResult = JsonObject;

export interface HarnessClientTools {
  close?(): void;
  list(): Promise<readonly HarnessClientTool[]>;
  call(input: {
    namespace: string;
    name: string;
    arguments: JsonValue;
    signal: {
      readonly aborted: boolean;
      addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
      removeEventListener(type: "abort", listener: () => void): void;
    };
  }): Promise<HarnessClientToolResult>;
}
