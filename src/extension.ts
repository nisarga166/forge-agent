import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ForgeClient, FallbackOptions, editedFiles } from "./trueforge";
import { startMcpServer } from "./mcpServer";
import { ToolHost } from "./tools";
import { inlineEdit } from "./inlineEdit";

let output: vscode.OutputChannel;
let activePanel: vscode.WebviewPanel | undefined; // so tools can show things in the chat panel

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Forge Agent");
  const host = makeHost();
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("forge.openPanel", () => openPanel(context)),
    vscode.commands.registerCommand("forge.inlineEdit", () => inlineEdit(host))
  );

  // Start the tool server so TrueForge can call our tools.
  const port = vscode.workspace.getConfiguration("forge").get<number>("mcpPort", 3917);
  const server = startMcpServer(port, host);
  server.on("listening", () => output.appendLine(`Tool server ready at http://localhost:${port}/mcp`));
  server.on("error", (err: any) => {
    const msg = err?.code === "EADDRINUSE"
      ? `Port ${port} is already used (is another VS Code window running Forge Agent?). Close it, or change the setting forge.mcpPort.`
      : `Tool server failed to start: ${err?.message ?? err}`;
    output.appendLine(msg);
    vscode.window.showErrorMessage("Forge Agent: " + msg);
  });
  context.subscriptions.push({ dispose: () => server.close() });
}

// The editor side of the tools: diff review, Yes/No prompts, saving files.
function makeHost(): ToolHost {
  return {
    root: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    log: (line) => output.appendLine(line),
    showContext: (summary) => {
      summary.forEach((l) => output.appendLine(l));
      activePanel?.webview.postMessage({ type: "context", lines: summary });
    },

    reviewEdit: async (absPath, oldContent, newContent, warning) => {
      const rel = vscode.workspace.asRelativePath(absPath);
      // Put "before" and "after" in temp files and open VS Code's diff view on them.
      const dir = path.join(os.tmpdir(), "forge-agent", String(Date.now()));
      fs.mkdirSync(dir, { recursive: true });
      const left = path.join(dir, "current-" + path.basename(absPath));
      const right = path.join(dir, "proposed-" + path.basename(absPath));
      fs.writeFileSync(left, oldContent);
      fs.writeFileSync(right, newContent);
      const rightUri = vscode.Uri.file(right);
      await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(left), rightUri,
        `Forge proposal: ${rel} (left = now, right = proposed)`, { preview: false });
      const ask = `Forge Agent wants to change ${rel}. Look at the diff, then choose.`;
      const pick = warning
        ? await vscode.window.showWarningMessage(`${warning}. ${ask}`, "Accept", "Reject")
        : await vscode.window.showInformationMessage(ask, "Accept", "Reject");
      // Close the diff tab again.
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.fsPath === rightUri.fsPath) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }
      output.appendLine(`${pick === "Accept" ? "Accepted" : "Rejected"} edit to ${rel}`);
      return pick === "Accept";
    },

    writeFile: async (absPath, newContent) => {
      editedFiles.add(vscode.workspace.asRelativePath(absPath)); // remembered for a fresh conversation (Task C)
      const uri = vscode.Uri.file(absPath);
      if (fs.existsSync(absPath)) {
        // Edit through VS Code so Ctrl+Z can undo it.
        const doc = await vscode.workspace.openTextDocument(uri);
        const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, all, newContent);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
      } else {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, newContent);
      }
      await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true });
    },

    approveCommand: async (command) => {
      const pick = await vscode.window.showWarningMessage(
        `Forge Agent wants to run this command in your project:\n\n${command}`, { modal: true }, "Run");
      output.appendLine(`${pick === "Run" ? "Allowed" : "Blocked"} command: ${command}`);
      return pick === "Run";
    },
  };
}

function openPanel(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("forge");
  const forge = new ForgeClient(
    cfg.get<string>("trueforgeUrl", "http://localhost:8790"),
    cfg.get<string>("agentName", "forge-coder"),
    fallbackOptions(cfg, "continue")
  );

  const panel = vscode.window.createWebviewPanel(
    "forgeAgent", "Forge Agent", vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = getHtml();
  activePanel = panel;
  panel.onDidDispose(() => { if (activePanel === panel) activePanel = undefined; });

  // Messages from the panel (the web page) to the extension.
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === "send") {
      panel.webview.postMessage({ type: "start" });
      try {
        // NOT awaited by the editor: VS Code stays responsive while tokens stream in.
        await forge.sendMessage(msg.text, {
          onToken: (t) => panel.webview.postMessage({ type: "token", text: t }),
          onTool: (line) => panel.webview.postMessage({ type: "tool", text: line }),
          onDone: (status, info) => panel.webview.postMessage({ type: "done", status, info }),
          onNotice: (line) => panel.webview.postMessage({ type: "notice", text: line }),
        });
      } catch (err: any) {
        // e.g. TrueForge not running. Show a clear message, never a stack trace.
        panel.webview.postMessage({
          type: "done", status: "error",
          info: friendlyError(err, cfg.get<string>("trueforgeUrl", "")),
        });
      }
    } else if (msg.type === "cancel") {
      await forge.cancel();
    } else if (msg.type === "new") {
      forge.reset();
    }
  }, undefined, context.subscriptions);
}

// Task C settings, shared by the chat panel and the inline edit.
export function fallbackOptions(cfg: vscode.WorkspaceConfiguration, resend: "continue" | "original"): FallbackOptions {
  return {
    backupModel: cfg.get<string>("backupModel", ""),
    stallSeconds: cfg.get<number>("stallSeconds", 120),
    maxSteps: cfg.get<number>("maxSteps", 60),
    resend,
  };
}

// Turn any failure into one clear sentence for the user (no stack traces).
function friendlyError(err: any, url: string): string {
  const body = err?.body?.error?.message;
  if (body) return "TrueForge said: " + body;
  if (err?.statusCode) return "TrueForge returned error " + err.statusCode + ".";
  return "Could not reach TrueForge at " + url + ". Is it running?";
}

function getHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; }
  #log { white-space: pre-wrap; border: 1px solid var(--vscode-panel-border); padding: 8px; min-height: 200px; margin-bottom: 8px; overflow-y: auto; max-height: 70vh; }
  .you { color: var(--vscode-textLink-foreground); margin-top: 8px; }
  .status { opacity: 0.7; font-style: italic; }
  .ctx { border-left: 3px solid var(--vscode-textLink-foreground); padding: 4px 8px; margin: 6px 0; font-size: 0.9em; }
  .ctx b { display: block; margin-bottom: 2px; }
  .tool { opacity: 0.8; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  .notice { border-left: 3px solid var(--vscode-editorWarning-foreground, orange); padding: 2px 6px; margin: 4px 0; }
  textarea { width: 100%; box-sizing: border-box; min-height: 60px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  button { margin-top: 4px; margin-right: 4px; }
</style></head>
<body>
  <div id="log"></div>
  <textarea id="input" placeholder="Ask the agent..."></textarea>
  <button id="send">Send</button>
  <button id="cancel" disabled>Cancel</button>
  <button id="new">New chat</button>
<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const cancelBtn = document.getElementById('cancel');
  let current = null;

  function add(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }

  sendBtn.onclick = () => {
    const text = input.value.trim(); if (!text) return;
    add('you', 'You: ' + text); input.value = '';
    vscode.postMessage({ type: 'send', text });
  };
  cancelBtn.onclick = () => { vscode.postMessage({ type: 'cancel' }); cancelBtn.disabled = true; };
  document.getElementById('new').onclick = () => { log.innerHTML = ''; vscode.postMessage({ type: 'new' }); };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'start') { current = add('agent', ''); sendBtn.disabled = true; cancelBtn.disabled = false; }
    if (m.type === 'token') {
      if (!current) current = add('agent', '');
      current.textContent += m.text; log.scrollTop = log.scrollHeight;
    }
    // A tool line goes below; the next words from the agent start a fresh block.
    if (m.type === 'tool') { add('tool', m.text); current = null; }
    if (m.type === 'notice') { add('notice', m.text); current = null; }
    if (m.type === 'context') {
      const box = add('ctx', '');
      const title = document.createElement('b'); title.textContent = '📚 ' + m.lines[0]; box.appendChild(title);
      for (const l of m.lines.slice(1)) { const d = document.createElement('div'); d.textContent = '• ' + l; box.appendChild(d); }
      current = null;
    }
    if (m.type === 'done') {
      sendBtn.disabled = false; cancelBtn.disabled = true;
      if (m.status === 'cancelled') add('status', '[Stopped by you]');
      if (m.status === 'error') add('status', '[Error] ' + m.info);
    }
  });
</script>
</body></html>`;
}

export function deactivate() {}
