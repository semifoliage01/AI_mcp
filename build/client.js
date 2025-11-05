"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const { default: OpenAI } = require("openai");
const mcpServerConfig_1 = __importDefault(require("./mcpServerConfig"));
const openai_1 = __importDefault(require("openai"));
const os_1 = require("os");
const readline_1 = require("readline");
const dotenv = require('dotenv').config();
//自己openaiKey
const OPENAI_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is required");
}
class MCPClient {
    static getOpenServers() {
        return mcpServerConfig_1.default.filter(cfg => cfg.isOpen).map(cfg => cfg.name);
    }
    constructor() {
        this.sessions = new Map();
        this.transports = new Map();
        this.openai = new openai_1.default({
            apiKey: OPENAI_API_KEY
        });
        this.openai = new OpenAI({
            baseURL: "https://api.deepseek.com",
            // 你的 Deepseek API Key
            apiKey: OPENAI_API_KEY,
            });
    }
    async connectToServer(serverName) {
        const serverConfig = mcpServerConfig_1.default.find(cfg => cfg.name === serverName);
        if (!serverConfig) {
            throw new Error(`Server configuration not found for: ${serverName}`);
        }
        let transport;
        console.log(`server command : ${serverConfig.command}`);
        if (serverConfig.type === "command" && serverConfig.command) {
            transport = await this.createCommandTransport(serverConfig.command);
        }
        else {
            throw new Error(`Invalid server configuration for: ${serverName}`);
        }
        const client = new index_js_1.Client({
            name: "hailuo_mcpClient",
            version: "1.0.0"
        }, {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {}
            }
        });
        await client.connect(transport);
        this.sessions.set(serverName, client);
        this.transports.set(serverName, transport);
        // 列出可用工具
        const response = await client.listTools();
        console.log(`\nConnected to server '${serverName}' with tools:`, response.tools.map((tool) => tool.name));
    }
    async createCommandTransport(shell) {
        const [command, ...shellArgs] = shell.split(' ');
        if (!command) {
            throw new Error("command為空");
        }
        //參數中~/調整
        const args = shellArgs.map(arg => {
            if (arg.startsWith('~/')) {
                return arg.replace('~', (0, os_1.homedir)());
            }
            return arg;
        });
        const serverParams = {
            command,
            args,
            env: Object.fromEntries(Object.entries(process.env).filter(([_, v]) => v !== undefined))
        };
        return new stdio_js_1.StdioClientTransport(serverParams);
    }
    async processQuery(query) {
        if (this.sessions.size === 0) {
            throw new Error("Not connected to any server");
        }
        const messages = [
            {
                role: "user",
                content: query
            }
        ];
        const availableTools = [];
        //取的所有server的tool
        for (const [serverName, session] of this.sessions) {
            const response = await session.listTools();
            const tools = response.tools.map((tool) => ({
                type: "function",
                function: {
                    name: `${serverName}__${tool.name}`,
                    description: `[${serverName}] ${tool.description}`,
                    parameters: tool.inputSchema
                }
            }));
            availableTools.push(...tools);
        }
        //call openai
        const completion = await this.openai.chat.completions.create({
            model: "deepseek-chat",
            messages,
            tools: availableTools,
            tool_choice: "auto"
        });
        const finalText = [];
        //處理openai回應
        for (const choice of completion.choices) {
            const message = choice.message;
            if (message.content) {
                finalText.push(message.content);
            }
            if (message.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    toolCall;
                    const [serverName, toolName] = toolCall.id.split('__'); //to be changed
                    const session = this.sessions.get(serverName);
                    if (!session) {
                        finalText.push(`[Error: Server ${serverName} not found]`);
                        continue;
                    }
                    const toolArgs = JSON.parse(toolCall.type); // to be changed
                    // 執行tool
                    const result = await session.callTool({
                        name: toolName,
                        arguments: toolArgs
                    });
                    const toolResult = result;
                    finalText.push(`[Calling tool "${toolName} 工具" on server ${serverName} 參數 ${JSON.stringify(toolArgs)}]`);
                    // console.log(toolResult.content);
                    finalText.push(toolResult.content);
                    messages.push({
                        role: "assistant",
                        content: "",
                        tool_calls: [toolCall]
                    });
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: toolResult.content
                    });
                    const nextCompletion = await this.openai.chat.completions.create({
                        model: "gpt-4o",
                        messages,
                        tools: availableTools,
                        tool_choice: "auto"
                    });
                    if (nextCompletion.choices[0].message.content) {
                        finalText.push(nextCompletion.choices[0].message.content);
                    }
                }
            }
        }
        return finalText.join("\n");
    }
    async chatLoop() {
        console.log("\nMCP Client Started!");
        console.log("Type your queries or 'quit' to exit.");
        const readline = (0, readline_1.createInterface)({
            input: process.stdin,
            output: process.stdout
        });
        const askQuestion = () => {
            return new Promise((resolve) => {
                readline.question("\n詢問指令: ", resolve);
            });
        };
        try {
            while (true) {
                const query = (await askQuestion()).trim();
                if (query.toLowerCase() === 'quit') {
                    break;
                }
                try {
                    const response = await this.processQuery(query);
                    console.log("\n" + response);
                }
                catch (error) {
                    console.error("\nError:", error);
                }
            }
        }
        finally {
            readline.close();
        }
    }
    async cleanup() {
        for (const transport of this.transports.values()) {
            await transport.close();
        }
        this.transports.clear();
        this.sessions.clear();
    }
    hasActiveSessions() {
        return this.sessions.size > 0;
    }
}
async function main() {
    const openServers = MCPClient.getOpenServers();
    console.log("连接所有MCP Server:", openServers.join(", "));
    const client = new MCPClient();
    try {
        // 連結所有開啟的Server
        for (const serverName of openServers) {
            console.log(`${serverName} 連線中...`);
            try {
                await client.connectToServer(serverName);
            }
            catch (error) {
                console.error(`Failed to connect to server '${serverName}':`, error);
            }
        }
        if (!client.hasActiveSessions()) {
            throw new Error("Failed to connect to any server");
        }
        await client.chatLoop();
    }
    finally {
        await client.cleanup();
    }
}
main().catch(console.error);
