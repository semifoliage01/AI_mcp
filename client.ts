import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import config from "./mcpServerConfig";
import OpenAI from "openai";
import { homedir } from 'os';
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createInterface } from "readline";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

//自己openaiKey
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is required");
}
interface MCPToolResult {
    content: string;
}
interface ServerConfig {
    name: string;
    type: 'command';
    command?: string;
    url?: string;
    isOpen?: boolean;
}
class MCPClient {
    static getOpenServers(): string[] {
        return config.filter(cfg => cfg.isOpen).map(cfg => cfg.name);
    }
    private openai: OpenAI;
    private sessions: Map<string, Client> = new Map();
    private transports: Map<string, StdioClientTransport> = new Map();
    constructor() {
        this.openai = new OpenAI({
            apiKey: OPENAI_API_KEY
        });
    }
    async connectToServer(serverName: string): Promise<void> {
        const serverConfig = config.find(cfg => cfg.name === serverName) as ServerConfig;
        if (!serverConfig) {
            throw new Error(`Server configuration not found for: ${serverName}`);
        }
        let transport: StdioClientTransport;
        console.log(`server command : ${serverConfig.command}`);
        if (serverConfig.type === "command" && serverConfig.command ){
            transport = await this.createCommandTransport(serverConfig.command);
        }else{
            throw new Error(`Invalid server configuration for: ${serverName}`);
        }
        const client = new Client(
            {
                name: "hailuo_mcpClient",
                version: "1.0.0"
            },
            {
                capabilities: {
                    prompts: {},
                    resources: {},
                    tools: {}
                }
            }
        );
        await client.connect(transport);
        this.sessions.set(serverName, client);
        this.transports.set(serverName, transport);
        // 列出可用工具
        const response = await client.listTools();
        console.log(`\nConnected to server '${serverName}' with tools:`, response.tools.map((tool: Tool) => tool.name));
    }
    private async createCommandTransport(shell: string): Promise<StdioClientTransport> {
        const [command, ...shellArgs] = shell.split(' ');
        if (!command) {
            throw new Error("command為空");
        }
        //參數中~/調整
        const args = shellArgs.map(arg => {
            if (arg.startsWith('~/')) {
                return arg.replace('~', homedir());
            }
            return arg;
        });
        const serverParams: StdioServerParameters = {
            command,
            args,
            env: Object.fromEntries(
                Object.entries(process.env).filter(([_, v]) => v !== undefined)
            ) as Record<string, string>
        };
        return new StdioClientTransport(serverParams);
    }
    async processQuery(query: string): Promise<string> {
        if (this.sessions.size === 0) {
            throw new Error("Not connected to any server");
        }
        const messages: ChatCompletionMessageParam[] = [
            {
                role: "user",
                content: query
            }
        ];
        const availableTools: any[] = [];
        //取的所有server的tool
        for (const [serverName, session] of this.sessions) {
            const response = await session.listTools();
            const tools = response.tools.map((tool: Tool) => ({
                type: "function" as const,
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
            model: "gpt-4o",
            messages,
            tools: availableTools,
            tool_choice: "auto"
        });
        const finalText: string[] = [];
        //處理openai回應
        for (const choice of completion.choices){
            const message = choice.message;
            if (message.content) {
                finalText.push(message.content);
            }
            if (message.tool_calls) {
                for (const toolCall of message.tool_calls){
                    toolCall
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
                    const toolResult = result as unknown as MCPToolResult;
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
    async chatLoop(): Promise<void>{
        console.log("\nMCP Client Started!");
        console.log("Type your queries or 'quit' to exit.");
        const readline = createInterface({
            input: process.stdin,
            output: process.stdout
        });
        const askQuestion = () => {
            return new Promise<string>((resolve) => {
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
                } catch (error) {
                    console.error("\nError:", error);
                }
            }
        } finally {
            readline.close();
        }
    }
    async cleanup(): Promise<void> {
        for (const transport of this.transports.values()) {
            await transport.close();
        }
        this.transports.clear();
        this.sessions.clear();
        
    }
    hasActiveSessions(): boolean {
        return this.sessions.size > 0;
    }
}
async function main() {
    const openServers = MCPClient.getOpenServers();
    console.log("連結所有MCP Server:", openServers.join(", "));
    const client = new MCPClient();
    try {
        // 連結所有開啟的Server
        for (const serverName of openServers) {
            console.log(`${serverName} 連線中...`);
            try {
                await client.connectToServer(serverName);
            } catch (error) {
                console.error(`Failed to connect to server '${serverName}':`, error);
            }
        }
        if (!client.hasActiveSessions()) {
            throw new Error("Failed to connect to any server");
        }
        await client.chatLoop();
    } finally {
        await client.cleanup();
    }
}
main().catch(console.error);