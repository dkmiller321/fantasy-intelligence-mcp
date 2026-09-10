import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "../server";

export function registerPing(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ping",
    {
      description:
        "Liveness check for this server. Returns the server version and current UTC time. " +
        "Use only to confirm the connection works; it carries no fantasy data.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: true, version: "0.1.0", now: ctx.now().toISOString() }),
        },
      ],
    }),
  );
}
