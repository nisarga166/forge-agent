// Day 5: CONTEXT ASSEMBLY
// Picks the most relevant pieces of code for a task, within a size budget,
// and says WHY each piece was chosen. No VS Code code here, so it is easy to test.
import * as fs from "fs";
import * as path from "path";

export interface ContextPick { file: string; score: number; why: string; snippet: string; }

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", "out", "dist", ".tox", "build"]);
const TEXT_EXT = new Set([".py", ".md", ".rst", ".txt", ".toml", ".cfg", ".ini", ".json", ".ts", ".js", ".html", ".yml", ".yaml"]);
const STOP = new Set(["the", "and", "for", "add", "with", "that", "this", "from", "into", "make", "new", "should",
  "use", "using", "like", "named", "existing", "similar", "when", "what", "which", "file", "files", "code", "please", "also", "then", "its", "not", "are", "can"]);
const CHARS_PER_TOKEN = 4; // rough rule: 1 token is about 4 characters of code

// Turn "Add a `flask config` command that prints the config" into ["flask","config","command","prints"].
export function keywords(task: string): string[] {
  const words = task.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

function walk(root: string, dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.endsWith(".egg-info") || e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(root, abs, out);
    else if (TEXT_EXT.has(path.extname(e.name)) && fs.statSync(abs).size < 300_000) out.push(abs);
  }
}

// Score every file with a simple "TF-IDF" idea:
//  - TF: how often a keyword appears in the file (capped, so one huge file can't win by size alone)
//  - IDF: how RARE the keyword is across the project. "flask" is in almost every file, so it
//    tells us little; "command" is in few files, so a match on it means a lot.
// A keyword in the file NAME counts extra. Files matching several rare keywords rank highest.
export function findRelevantCode(root: string, task: string, budgetTokens = 6000): { picks: ContextPick[]; usedTokens: number; keywords: string[] } {
  const kws = keywords(task);
  const paths: string[] = [];
  walk(root, root, paths);
  const files = paths.map((abs) => {
    const text = fs.readFileSync(abs, "utf8");
    return { abs, rel: path.relative(root, abs).split(path.sep).join("/"), text, lower: text.toLowerCase(),
             base: path.basename(abs).toLowerCase() };
  });
  const N = files.length;
  const idf: Record<string, number> = {};
  for (const k of kws) {
    const df = files.filter((f) => f.lower.includes(k) || f.base.includes(k)).length;
    idf[k] = Math.log((N + 1) / (df + 1)); // 0 when every file has it, big when rare
  }
  const useful = kws.filter((k) => idf[k] > 0.3); // ignore words that are everywhere

  const scored = files.map((f) => {
    let score = 0;
    let covered = 0;
    const hits: string[] = [];
    for (const k of useful) {
      const inName = f.base.includes(k);
      const count = f.lower.split(k).length - 1;
      if (!inName && !count) continue;
      // Is it DEFINED here? ("def k", "class k", or a click "@...command" for k) -> very strong signal
      const defined = new RegExp(`(def|class)\\s+${k}\\b`).test(f.lower);
      covered++;
      hits.push(`"${k}"${defined ? " defined" : ""}${inName ? " in name" : ""}${count ? ` x${count}` : ""}`);
      // Rare words matter much more (idf squared); repeats matter less and less (log).
      score += idf[k] * idf[k] * (Math.log(1 + count) + (inName ? 3 : 0) + (defined ? 5 : 0));
    }
    score *= covered;
    if (f.rel.startsWith("src/")) score *= 1.3;
    return { ...f, score, why: hits.join(", ") };
  }).filter((f) => f.score > 0).sort((a, b) => b.score - a.score);

  // Diversity: for each rare keyword, make sure the source file that uses it MOST is included,
  // even if it doesn't match the other words. (For "add a config command", this pulls in the
  // file where the other commands live.) Those files go first, then the best overall scores.
  const champions: typeof scored = [];
  for (const k of [...useful].sort((a, b) => idf[b] - idf[a])) {
    const uses = (f: { lower: string }) => f.lower.split(k).length - 1;
    const best = scored.filter((f) => f.rel.startsWith("src/") && uses(f) >= 3).sort((a, b) => uses(b) - uses(a))[0];
    if (best && !champions.includes(best)) { best.why = `most uses of "${k}"; ` + best.why; champions.push(best); }
  }
  const top = scored.slice(0, 2);
  const extra = champions.filter((c) => !top.includes(c)).slice(0, 3);
  const ordered = [...top, ...extra, ...scored.filter((f) => !top.includes(f) && !extra.includes(f))];

  // Fill the budget: for each top file, take the lines around the rare keywords.
  const picks: ContextPick[] = [];
  let used = 0;
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  for (const f of ordered.slice(0, 15)) {
    const snippet = snippetAround(f.text, useful, 4, 50);
    const cost = snippet.length + 100;
    if (used + cost > budgetChars) continue; // too big, try the next (smaller) file
    picks.push({ file: f.rel, score: Math.round(f.score), why: f.why, snippet });
    used += cost;
    if (picks.length >= 8) break;
  }
  return { picks, usedTokens: Math.round(used / CHARS_PER_TOKEN), keywords: useful };
}

// Keep only the lines near a keyword (plus `pad` lines around), numbered, at most `maxLines`.
function snippetAround(text: string, kws: string[], pad: number, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    const low = l.toLowerCase();
    if (kws.some((k) => low.includes(k))) for (let j = i - pad; j <= i + pad; j++) if (j >= 0 && j < lines.length) keep.add(j);
  });
  const idx = [...keep].sort((a, b) => a - b).slice(0, maxLines);
  const out: string[] = [];
  let prev = -2;
  for (const i of idx) {
    if (i !== prev + 1) out.push("...");
    out.push(`${i + 1}: ${lines[i]}`);
    prev = i;
  }
  return out.join("\n");
}

export function formatContext(r: ReturnType<typeof findRelevantCode>): string {
  if (r.picks.length === 0) return `No files matched the keywords: ${r.keywords.join(", ")}. Try list_files or search_code.`;
  const head = `Context chosen for keywords [${r.keywords.join(", ")}], about ${r.usedTokens} tokens. ` +
    `These are SNIPPETS; use read_file for the full file before editing.\n`;
  return head + r.picks.map((p) => `\n=== ${p.file} (score ${p.score}; why: ${p.why}) ===\n${p.snippet}`).join("\n");
}
