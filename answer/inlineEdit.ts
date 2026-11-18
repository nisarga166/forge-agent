// Day 4: INLINE EDIT (Task A)
// You select some code, press Ctrl+Alt+K, type an instruction,
// the model rewrites ONLY the selected code, and you review a diff.
import * as vscode from "vscode";
import { ForgeClient } from "./trueforge";
import { ToolHost } from "./tools";

export async function inlineEdit(host: ToolHost): Promise<void> {
  // STEP 1: which file is open, and what code is selected?
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage("Select some code first, then press Ctrl+Alt+K.");
    return;
  }
  const doc = editor.document;
  const selected = doc.getText(editor.selection);

  // STEP 2: ask the user what to change.
  const instruction = await vscode.window.showInputBox({
    prompt: "What should Forge change in the selected code?",
    placeHolder: "e.g. treat 'off' as false too",
  });
  if (!instruction) return; // user pressed Escape

  // STEP 3: build the message for the model.
  const prompt =
    "You are doing an INLINE EDIT. Do not use any tools.\n" +
    `File: ${vscode.workspace.asRelativePath(doc.uri)} (language: ${doc.languageId})\n` +
    `Instruction: ${instruction}\n\n` +
    "Here is the selected code:\n<<<\n" + selected + "\n>>>\n\n" +
    "Reply with ONLY the new version of the selected code. Keep the same indentation. " +
    "No explanation, no markdown fences.";

  // STEP 4: send it to TrueForge and collect the streamed reply into one string.
  const cfg = vscode.workspace.getConfiguration("forge");
  const forge = new ForgeClient(cfg.get<string>("trueforgeUrl", "http://localhost:8790"),
                                cfg.get<string>("agentName", "forge-coder"));
  let reply = "";
  let failed = "";
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Forge is editing...", cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => forge.cancel());
      try {
        await forge.sendMessage(prompt, {
          onToken: (t) => { reply += t; },
          onTool: () => {},
          onDone: (status, info) => { if (status !== "done") failed = status + " " + info; },
        });
      } catch (err: any) {
        failed = "Could not reach TrueForge. Is it running?";
      }
    });
  if (failed) { vscode.window.showErrorMessage("Inline edit stopped: " + failed); return; }
  let newCode = stripFences(reply);
  if (selected.endsWith("\n") && !newCode.endsWith("\n")) newCode += "\n"; // keep the line break

  // STEP 5: build the whole file with the selection swapped for the new code.
  const before = doc.getText();
  const start = doc.offsetAt(editor.selection.start);
  const end = doc.offsetAt(editor.selection.end);
  const after = before.slice(0, start) + newCode + before.slice(end);

  // STEP 6: show the diff; only write if the user clicks Accept.
  if (await host.reviewEdit(doc.uri.fsPath, before, after)) {
    await host.writeFile(doc.uri.fsPath, after);
  }
}

// Models sometimes wrap code in ```python ... ``` even when told not to. Remove that.
// Careful: do not trim the START of the first line, or we would lose its indentation.
function stripFences(text: string): string {
  const t = text.replace(/^\s*\n/, "").replace(/\s+$/, ""); // drop blank lines at start, spaces at end
  const m = t.trim().match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/);
  return m ? m[1] : t;
}
