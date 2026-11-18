// The agent's "hands": tools the model can call to look at and change your project.
// This file has NO VS Code code in it, so it is easy to test. Anything that needs
// the editor (showing a diff, asking you Yes/No) comes in through the ToolHost.
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";

export interface ToolHost {
  root: () => string | undefined; // the open project folder
  reviewEdit: (absPath: string, oldContent: string, newContent: string, warning?: string) => Promise<boolean>;
  writeFile: (absPath: string, newContent: string) => Promise<void>;
  approveCommand: (command: string) => Promise<boolean>;
  log: (line: string) => void;
  showContext?: (summary: string[]) => void; // shows the "Context chosen" box in the panel
}

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", "out", "dist", ".tox"]);
const MAX_LIST = 300;
const MAX_READ_LINES = 400;
const MAX_MATCHES = 50;
const MAX_OUTPUT = 8000;

// Turn a path from the model into a safe absolute path INSIDE the project.
// Stops the model from reading/writing things like C:\Windows or ../../secrets.
export function resolveSafe(host: ToolHost, rel: string): string {
  const root = host.root();
  if (!root) throw new Error("No folder is open in VS Code. Open a project folder first.");
  const abs = path.resolve(root, rel || ".");
  const relBack = path.relative(root, abs);
  if (relBack.startsWith("..") || path.isAbsolute(relBack)) {
    throw new Error(`Path "${rel}" is outside the project folder.`);
  }
  return abs;
}

function toRel(host: ToolHost, abs: string): string {
  return path.relative(host.root()!, abs).split(path.sep).join("/") || ".";
}

export function listFiles(host: ToolHost, rel = ".", depth = 3): string {
  const start = resolveSafe(host, rel);
  if (!fs.existsSync(start)) return `Not found: ${rel}`;
  const out: string[] = [];
  const walk = (dir: string, level: number) => {
    if (out.length >= MAX_LIST) return;
    let entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_LIST) return;
      if (SKIP_DIRS.has(e.name) || e.name.endsWith(".egg-info")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(toRel(host, abs) + "/");
        if (level < depth) walk(abs, level + 1);
      } else {
        out.push(toRel(host, abs));
      }
    }
  };
  walk(start, 1);
  if (out.length >= MAX_LIST) out.push(`... (stopped at ${MAX_LIST} entries; list a smaller folder)`);
  return out.join("\n") || "(empty folder)";
}

export function readFile(host: ToolHost, rel: string, startLine?: number, endLine?: number): string {
  const abs = resolveSafe(host, rel);
  if (!fs.existsSync(abs)) return `File not found: ${rel}`;
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const s = Math.max(1, startLine ?? 1);
  const e = Math.min(lines.length, endLine ?? s + MAX_READ_LINES - 1, s + MAX_READ_LINES - 1);
  const body = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n");
  const more = e < lines.length ? `\n... (file has ${lines.length} lines; ask for start_line=${e + 1} to read more)` : "";
  return `${rel} (lines ${s}-${e} of ${lines.length})\n${body}${more}`;
}

export function searchCode(host: ToolHost, query: string, rel = "."): string {
  const start = resolveSafe(host, rel);
  const q = query.toLowerCase();
  const hits: string[] = [];
  const walk = (p: string) => {
    if (hits.length >= MAX_MATCHES) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) {
        if (SKIP_DIRS.has(name) || name.endsWith(".egg-info")) continue;
        walk(path.join(p, name));
      }
    } else if (st.size < 1_000_000) {
      const text = fs.readFileSync(p, "utf8");
      if (text.includes("\u0000")) return; // skip binary files
      text.split(/\r?\n/).forEach((line, i) => {
        if (hits.length < MAX_MATCHES && line.toLowerCase().includes(q)) {
          hits.push(`${toRel(host, p)}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    }
  };
  walk(start);
  if (hits.length === 0) return `No matches for "${query}".`;
  return hits.join("\n") + (hits.length >= MAX_MATCHES ? `\n... (first ${MAX_MATCHES} matches only)` : "");
}

// Names of functions and classes defined in a piece of Python code.
export function definedNames(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(/^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+([A-Za-z_]\w*)/gm)) names.push(m[1]);
  return names;
}

// Guard (Day 7): which existing functions/classes would this edit delete?
// The agent once used an existing test as an "anchor" and overwrote it. Plain code checks this
// on every edit, so it works even when the model forgets the instructions.
export function removedDefinitions(oldText: string, newText: string): string[] {
  const after = new Set(definedNames(newText));
  return [...new Set(definedNames(oldText))].filter((n) => !after.has(n));
}

export async function proposeEdit(host: ToolHost, rel: string, oldText: string, newText: string, allowDelete = false): Promise<string> {
  const abs = resolveSafe(host, rel);
  const exists = fs.existsSync(abs);
  let before = "";
  let after: string;
  if (!exists) {
    if (oldText !== "") return `File ${rel} does not exist. To create it, call propose_edit with old_text = "" (empty).`;
    after = newText;
  } else {
    before = fs.readFileSync(abs, "utf8");
    if (oldText === "") return `File ${rel} already exists. Give old_text: the exact lines to replace (read the file first).`;
    // Models often send \n while Windows files use \r\n. Match either way.
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    const o = oldText.replace(/\r?\n/g, eol);
    const n = newText.replace(/\r?\n/g, eol);
    const count = before.split(o).length - 1;
    if (count === 0) return `old_text was not found in ${rel}. Read the file again and copy the lines exactly (including spaces).`;
    if (count > 1) return `old_text appears ${count} times in ${rel}. Include a few more surrounding lines so it is unique.`;
    after = before.replace(o, () => n);
  }
  const removed = exists ? removedDefinitions(oldText, newText) : [];
  if (removed.length && !allowDelete) {
    host.log(`Blocked edit to ${rel}: it would delete ${removed.join(", ")}`);
    return `BLOCKED: this edit would DELETE existing code: ${removed.join(", ")} in ${rel}. ` +
      `To ADD code next to existing code, new_text must contain old_text unchanged PLUS your new code. ` +
      `If you really mean to delete it, call propose_edit again with allow_delete = true and say why.`;
  }
  const warning = removed.length ? `⚠ This edit DELETES: ${removed.join(", ")}` : undefined;
  host.log(`Reviewing edit to ${rel}...`);
  const ok = await host.reviewEdit(abs, before, after, warning);
  if (!ok) return `The user REJECTED this edit to ${rel}. Do not apply it again; ask what they want instead.`;
  await host.writeFile(abs, after);
  return exists ? `Edit applied to ${rel}.` : `Created ${rel}.`;
}

export async function runCommand(host: ToolHost, command: string): Promise<string> {
  const root = host.root();
  if (!root) return "No folder is open in VS Code.";
  const ok = await host.approveCommand(command);
  if (!ok) return `The user did NOT allow running: ${command}`;
  host.log(`Running: ${command}`);
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  return new Promise((resolve) => {
    exec(command, { cwd: root, shell, timeout: 120_000, maxBuffer: 10_000_000 }, (err, stdout, stderr) => {
      let text = `$ ${command}\n${stdout}${stderr ? "\n[stderr]\n" + stderr : ""}`;
      if (err && (err as any).killed) text += "\n[Stopped: took longer than 2 minutes]";
      else if (err) text += `\n[Exit code ${err.code}]`;
      else text += "\n[Exit code 0]";
      if (text.length > MAX_OUTPUT) text = text.slice(0, 2000) + "\n... (output cut) ...\n" + text.slice(-6000);
      resolve(text);
    });
  });
}
