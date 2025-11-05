import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";


//新增MCP Server
const server = new McpServer({
    name: "HailuoMCPServer",
    version: "1.0.0"
});
//建立tool
server.tool("who",
    '问我是谁',
    { name: z.string() },
    async ({name}) => {
      return {
        content: [{ type: "text", text: `我是海螺MCP Server ${name} 你好` }]
      }
    }
);
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main();