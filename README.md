# Forge Agent: a VS Code coding agent that runs on TrueForge

Built for the Techfest IIT Bombay x TrueFoundry **Forge-a-thon**, Round 1.

- **Demo video:** https://youtu.be/y4duBBP3RRA
- **Write-up (PDF):** docs/writeup.pdf
- **Starting point:** built **from scratch** (VS Code extension template). We first tried to fork Continue, but it would not build on Windows with the Node version TrueForge needs, so we switched on day 2. See [docs/ENGINEERING_LOG.md](docs/ENGINEERING_LOG.md), row 5.

## What it does

| Feature | How to use it |
|---|---|
| **Inline edit** (Task A) | Select code, press **Ctrl+Alt+K**, type an instruction, review the diff, Accept or Reject. Ctrl+Z undoes it. |
| **Agent mode** (Task B) | **Ctrl+Shift+P → Forge: Open Agent Panel**. The agent finds the right files itself, proposes each edit as a diff, and runs tests (with your permission). Streaming replies, **Cancel**, **New chat**. |
| **Resilience** (Task C) | If the model fails (bad key, rate limit, no reply, conversation too long) the extension retries, switches to a backup model, or stops with one clear message. Your files stay safe. |
| **Delete guard** | Plain code (not the model) blocks any edit that would delete an existing function or test, unless the agent explicitly asks and you see a warning. |

## How it is built

```
VS Code extension (this repo)                 TrueForge (runs locally, port 8790)
 ├─ chat panel / inline edit  ── SDK ──────▶  agent "forge-coder" (agent/forge-coder.json)
 │                                              │  the agent loop runs HERE
 └─ MCP tool server :3917/mcp  ◀── MCP ──────  │  calls our editor tools
      list_files, read_file, search_code,       └─▶ model (Gemini primary, Groq Qwen backup)
      find_relevant_code, propose_edit, run_command
```

- The extension never talks to a model directly. It only uses the TrueForge SDK.
- Editor actions are **MCP tools** served by the extension itself, so `propose_edit` can open a real VS Code diff and wait for your Accept/Reject.
- `find_relevant_code` chooses context automatically: it scores files by how rare and how frequent the task's keywords are (TF-IDF style), then fills a 6000-token budget with snippets, and shows a **"Context chosen"** box in the panel saying why each file was picked.

| File | What it does |
|---|---|
| `src/extension.ts` | Commands, chat panel, starts the tool server, diff view with Accept/Reject |
| `src/trueforge.ts` | TrueForge session, streaming, cancel, and the fallback ladder (retry → backup → fresh conversation → stop) |
| `src/mcpServer.ts` | The MCP server and the tool descriptions the model reads |
| `src/tools.ts` | What each tool does, including the delete guard |
| `src/context.ts` | Context selection for `find_relevant_code` |
| `src/inlineEdit.ts` | Inline edit (selection only, no tools) |
| `agent/forge-coder.json` | The exact TrueForge agent used in the demo |

## Run it (Windows)

Needs Node 22.14+, VS Code, Python, Git.

1. **Start TrueForge** in its own PowerShell window:
   ```powershell
   $env:OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'   # lets TrueForge reach the local tool server
   $env:MCP_REQUEST_TIMEOUT_MS="600000"                          # 10 min to review a diff
   npx @truefoundry/trueforge@latest
   ```
2. **Add models** in TrueForge (localhost:8790): a primary and a backup. See `models.example.json` (fake keys; real keys go only into TrueForge).
3. **Build the extension:** in this folder, `npm install` then `npm run compile`.
4. **Open the test project with the extension:**
   ```powershell
   code --extensionDevelopmentPath="$PWD" "PATH\TO\flask"
   ```
5. In TrueForge: **Connectors → Add MCP Server**, name `forge-editor-tools`, URL `http://localhost:3917/mcp`. Then import or create the agent from `agent/forge-coder.json`, with the connector's **preload** turned on.
6. In VS Code settings, set `forge.backupModel` to your backup (for example `groq/qwen-27b`).

Test project: `git clone https://github.com/pallets/flask` → `git checkout 3.1.3`, make a `.venv`, `pip install -e . "pytest<9"`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `forge.trueforgeUrl` | `http://localhost:8790` | Where TrueForge runs |
| `forge.agentName` | `forge-coder` | Which TrueForge agent to use |
| `forge.mcpPort` | `3917` | Port of the built-in tool server |
| `forge.backupModel` | (empty) | Model to switch to when the main one fails |
| `forge.stallSeconds` | `120` | No reply for this long = model is broken (paused while a tool waits for you) |
| `forge.maxSteps` | `60` | Stop an agent that loops |

## What happens when the model breaks

| Problem | What the extension does |
|---|---|
| Temporary (429, timeout, 5xx) | Waits as long as the provider asks (5–65 s), retries once |
| Still failing, or permanent (bad key, unknown model) | Switches the same conversation to the backup model |
| Backup cannot read the old history | Fresh conversation on the backup, with the task and the list of files already changed |
| Conversation too long | Fresh conversation on the same model, with that list |
| No reply for 120 s | Treated as broken (same steps) |
| Backup fails too | Stops with one clear sentence; accepted edits stay and Ctrl+Z undoes them |

## Results

See the run log and every bug we found in [docs/ENGINEERING_LOG.md](docs/ENGINEERING_LOG.md).

## Limitations

- Tested on Windows only.
- Review is per edit (one Accept/Reject per proposed change), not per line.
- Context selection is keyword based; it works best when the task names a similar existing feature.
- The agent can still invent example output in docs (it wrote an `ENV` key that Flask 3.x does not have), even with a rule against it. Next step: a check in code that runs the command, or compares example keys with `default_config`, before the docs edit is shown.
- Free-tier models have small rate limits, so long agent tasks can pause to wait.

## Tools used

Built with help from Claude (Anthropic) as a coding assistant. Design decisions, testing, debugging and this write-up were done by the team.

## License

MIT, see [LICENSE](LICENSE). Flask is not included in this repo.
