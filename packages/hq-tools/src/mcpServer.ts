import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createDefaultRegistry, createHQGatewayTools, type HQContext } from "./index.js";

/**
 * Starts the HQ MCP Server.
 * Exposes the full HQ tool registry via the 2-tool gateway pattern.
 */
export async function startHQMcpServer(ctx: HQContext) {
  const server = new Server(
    {
      name: "agent-hq",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const registry = createDefaultRegistry(ctx);
  const [discoverTool, callTool] = createHQGatewayTools(registry, ctx);

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: discoverTool.name,
          description: discoverTool.description,
          inputSchema: discoverTool.parameters as any,
        },
        {
          name: callTool.name,
          description: callTool.description,
          inputSchema: callTool.parameters as any,
        },
      ],
    };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === discoverTool.name) {
        const result = await discoverTool.execute("mcp-call", args as any);
        return {
          content: result.content,
        };
      }

      if (name === callTool.name) {
        const result = await callTool.execute("mcp-call", args as any);
        return {
          content: result.content,
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HQ MCP Server running on stdio");
}
