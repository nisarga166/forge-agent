// A tiny MCP server that lives inside the extension. TrueForge connects to it at
// http://localhost:<port>/mcp and the model can then call our tools.
import * as http from "http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { findRelevantCode, formatContext } from "./context";
import { ToolHost, listFiles, readFile, searchCode, proposeEdit, runCommand } from "./tools";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// Wrap every tool so an exception becomes a clear message for the model, not a crash.
function safe(name: string, host: ToolHost, fn: () => string | Promise<string>) {
  return async (): Promise<ToolResult> => {
    try {
      return { content: [{ type: "text", text: await fn() }] };
    } catch (err: any) {
      host.log(`Tool ${name} failed: ${err?.message ?? err}`);
      return { content: [{ type: "text", text: `Error in ${name}: ${err?.message ?? err}` }], isError: true };
    }
  };
}

function buildServer(host: ToolHost): McpServer {
  const server = new McpServer({ name: "forge-editor-tools", version: "0.1.0" });

  server.registerTool("list_files", {
    description: "List files and folders in the open project (skips .git, .venv, node_modules). Paths are relative to the project root.",
    inputSchema: {
      path: z.string().optional().describe("Folder to list, relative to project root. Default '.'"),
      depth: z.number().int().min(1).max(6).optional().describe("How many folder levels deep. Default 3"),
    },
  }, (a) => safe("list_files", host, () => listFiles(host, a.path ?? ".", a.depth ?? 3))());

  server.registerTool("read_file", {
    description: "Read a text file with line numbers. Reads at most 400 lines at a time; use start_line/end_line for big files.",
    inputSchema: {
      path: z.string().describe("File path relative to project root, e.g. src/flask/helpers.py"),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    },
  }, (a) => safe("read_file", host, () => readFile(host, a.path, a.start_line, a.end_line))());

  server.registerTool("search_code", {
    description: "Case-insensitive text search across the project. Returns up to 50 'path:line: text' matches.",
    inputSchema: {
      query: z.string().min(1).describe("Text to look for, e.g. get_debug_flag"),
      path: z.string().optional().describe("Limit search to this folder or file. Default whole project"),
    },
  }, (a) => safe("search_code", host, () => searchCode(host, a.query, a.path ?? "."))());

  server.registerTool("find_relevant_code", {
    description:
      "START HERE for any coding task. Give it the task in plain words; it returns the most relevant code snippets " +
      "from the project (within a size budget) and why each was chosen. Then read_file the files you will change.",
    inputSchema: {
      task: z.string().min(3).describe("The task in plain words, e.g. 'add a flask config command that prints the app config'"),
      budget_tokens: z.number().int().min(500).max(20000).optional().describe("Max size of the returned context. Default 6000"),
    },
  }, (a) => safe("find_relevant_code", host, () => {
    const root = host.root();
    if (!root) throw new Error("No folder is open in VS Code.");
    const r = findRelevantCode(root, a.task, a.budget_tokens ?? 6000);
    host.showContext?.([
      `Context chosen (~${r.usedTokens} of ${a.budget_tokens ?? 6000} tokens) for: ${r.keywords.join(", ")}`,
      ...r.picks.map((p) => `${p.file}  (${p.why})`),
    ]);
    return formatContext(r);
  })());

  server.registerTool("propose_edit", {
    description:
      "The ONLY way to change files. Replaces old_text with new_text in a file. The user sees a diff and must Accept. " +
      "old_text must match the file exactly (copy it from read_file without the line-number prefixes) and appear once. " +
      "To create a new file, use old_text = \"\" and put the whole file in new_text. " +
      "Edits that would delete existing functions or classes are blocked unless allow_delete is true.",
    inputSchema: {
      path: z.string().describe("File path relative to project root"),
      old_text: z.string().describe("Exact existing text to replace, or empty string to create a new file"),
      new_text: z.string().describe("Replacement text. To add code next to existing code, repeat old_text unchanged and add your code"),
      allow_delete: z.boolean().optional().describe("Only true if you really mean to delete existing functions or classes"),
    },
  }, (a) => safe("propose_edit", host, () => proposeEdit(host, a.path, a.old_text, a.new_text, a.allow_delete ?? false))());

  server.registerTool("run_command", {
    description:
      "Run a shell command in the project root (PowerShell on Windows) after the user approves it. 2 minute limit. " +
      "On Windows use ';' (not '&&') between commands. There is no grep: to search code use the search_code tool. " +
      "Use it to run tests, e.g. '.venv\\Scripts\\python -m pytest tests/test_cli.py -q'.",
    inputSchema: { command: z.string().min(1) },
  }, (a) => safe("run_command", host, () => runCommand(host, a.command))());

  return server;
}

export function startMcpServer(port: number, host: ToolHost): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) { res.writeHead(404).end("Not found"); return; }
    if (req.method !== "POST") {
      // Stateless server: no long-lived GET stream, no sessions to DELETE.
      res.writeHead(405, { "Content-Type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null,
      }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      // A fresh server + transport per request = simple and safe (no shared state).
      const server = buildServer(host);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err: any) {
      host.log(`MCP request failed: ${err?.message ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null,
        }));
      }
    }
  });
  httpServer.listen(port, "127.0.0.1");
  return httpServer;
}
