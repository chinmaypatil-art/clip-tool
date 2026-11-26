// Usage: node scripts/check-mcp.mts  — starts the MCP server, lists clips, fetches one clip pack.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "check", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["scripts/clipwise-mcp.mts"] }));
console.log((await client.listTools()).tools.map((t) => t.name));
const list = await client.callTool({ name: "list_clips", arguments: { limit: 3 } }) as { content: { text: string }[] };
console.log(list.content[0].text);
const m = /analysisId=(\S+) clipId=(\S+)/.exec(list.content[0].text);
if (!m) throw new Error("no clips");
const pack = await client.callTool({ name: "get_clip_pack", arguments: { analysisId: m[1], clipId: m[2] } }) as { content: { type: string; text?: string; data?: string }[] };
console.assert(pack.content.filter((c) => c.type === "image").length === 4, "expected 4 images");
console.log(pack.content[0].text?.slice(0, 600), "\nimage KB:", pack.content.filter((c) => c.data).map((c) => Math.round(c.data!.length * 0.75 / 1024)));
await client.close();
