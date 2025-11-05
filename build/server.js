"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
//新增MCP Server
const server = new mcp_js_1.McpServer({
    name: "HailuoMCPServer",
    version: "1.0.0"
});
//建立tool
server.tool("who", '问我是谁', { name: zod_1.z.string() }, async ({ name }) => {
    return {
        content: [{ type: "text", text: `我是海螺MCP Server ${name} 你好` }]
    };
});
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
}
main();
