# Engineering log: what broke, why, and what we changed

Every row below happened for real while building and testing this extension on Windows, between 14 and 18 Nov 2026. Each fix was checked by re-running the task, not just by reading the code.

## 1. Setting up

| # | What we saw | Why it happened | What we changed | How we proved it |
|---|---|---|---|---|
| 1 | `npx` would not run in PowerShell | Windows blocks unsigned scripts by default | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` | TrueForge started |
| 2 | Flask 3.1.3 tests failed before we changed anything | pytest 9 is newer than this Flask release supports | `pip install "pytest<9"` | `test_cli.py`: 58 passed on the clean repo (our baseline) |
| 3 | Groq `gpt-oss` models broke on the 2nd message | They are "reasoning" models, and Groq rejects its own `reasoning_content` when it is sent back in the history | Use Gemini as primary and Groq Qwen (non-reasoning) as backup | Multi-turn chat works on both |
| 4 | F5 never started the extension ("STOPPED on first line for debugging") | The VS Code debugger launch was stuck on this laptop | Launch without the debugger: `code --extensionDevelopmentPath="$PWD"` | The hello-world popup appeared |
| 5 | The Continue fork would not build | Continue wants Node 20; TrueForge needs Node 22.14+; a Windows build script was missing a package | **Decision: build from scratch** (Plan B) instead of forking | Our own extension streamed from TrueForge the same day |
| 6 | `require()` of the TrueForge SDK failed at runtime | The SDK ships only as an ES module | Bundle the extension with esbuild | The extension loads and streams |

## 2. Connecting TrueForge to the editor tools

| # | What we saw | Why | What we changed | Proof |
|---|---|---|---|---|
| 7 | TrueForge refused our tool server at `localhost:3917` | TrueForge blocks local URLs by default (a safety rule) | Start it with `OUTBOUND_URL_ALLOWED_HOSTS=["localhost","127.0.0.1"]` | Tools appear in TrueForge |
| 8 | A diff review longer than 2 minutes failed the tool call | MCP calls time out after 2 minutes by default, but a human may take longer to review | `MCP_REQUEST_TIMEOUT_MS=600000` (10 minutes) | A slow review no longer times out |
| 9 | The agent wasted steps calling `list_tools` / `get_tool_info` | The connector's "preload tools" was off, so tools were hidden behind meta-tools | Turn preload on for the connector | The agent calls our tools directly |
| 10 | The agent tried `grep` in PowerShell | It assumed Linux | The `run_command` description says "no grep, use search_code" | No more grep attempts |

## 3. When the model fails (Task C)

| # | What we saw | Why | What we changed | Proof |
|---|---|---|---|---|
| 11 | Gemini free tier returned 429 (rate limit) in the middle of Task B | Free quota per minute | Retry once on the same model, then switch to the backup model | Tested with fake models and live |
| 12 | Our fixed 5-second retry still hit 429 | Gemini said "retry in 59 s", and 5 s was too short | Read the wait time from the error message (5 to 65 s) | Live run: waited 59 s, then finished |
| 13 | Groq returned 400 "messages.14 role:assistant must be ..." after the switch | Each provider writes chat history in a slightly different format; Groq could not read Gemini's history | Start a **fresh** conversation on the backup, with the task and a "handoff" note listing the files already changed | Backup finished the task |
| 14 | "Conversation too long" | Long tool results filled the model's context | Fresh conversation on the **same** model with the handoff (waiting would not make it shorter; the smaller backup would fail sooner) | Tested with a fake model |
| 15 | A model could hang forever | No answer, no error | Watchdog: no reply for 120 s counts as a failure. It is **paused while a tool runs**, because the tool may be waiting for a human to click Accept | 12 s review: no false alarm |
| 16 | An agent could loop | Nothing stopped it | Step limit: 60 steps per message | |

## 4. When the model is wrong (Task B quality)

| # | What we saw | Why | What we changed | Proof |
|---|---|---|---|---|
| 17 | Run 2: "all tests passed" but only **58** tests ran, not 59 | The agent used `test_host` as an anchor for its edit and replaced it instead of inserting after it. **A test was silently deleted.** Found by counting tests, not by reading "passed" | (a) Rule: new_text = old_text + new code, never delete tests. (b) **Guard in plain code**: `propose_edit` blocks any edit that removes an existing `def`/`class` unless the agent passes `allow_delete=true`, and then the human sees a warning | Run 3: 61 insertions, **0 deletions**, 59 passed |
| 18 | Run 2 also left `config_cmd.py`, which nothing imported | The agent created a new file, then wrote the real code elsewhere | Rule: only create a file if existing code will use it | Run 3: no extra file |
| 19 | The docs example showed an `"ENV"` key | The model invented example output; Flask 3.x has no ENV setting (it is not in `default_config` in `app.py`). Older Flask versions had it, so the model "remembers" it | Rule added: example output in docs must come from actually running the command | **Not fixed.** The final recorded run (18 Nov) still wrote `"ENV": "production"` despite the rule. Lesson: an instruction is a request, not a guarantee. A real fix needs a check in code (see Known limitations) |
| 20 | Task A on Qwen through the **chat panel** hit 429, "conversation too long", then a broken tool call | The panel has no selection, so the agent searched for "off", "true", "no" across the whole repo and the results flooded Qwen's 7000 tokens/minute limit | Not a bug: this is why **inline edit** exists. It sends only the selection and allows no tools. Same task with Ctrl+Alt+K on Qwen: 10 s, correct | Run log, 18 Nov |

## What these taught us

- **Count, don't trust.** "Tests passed" hid a deleted test. Count the tests and read the diff stats.
- **The checker must not depend on the thing that fails.** The delete guard is plain code, not a model instruction, so it still works when the model ignores the rules.
- **Defence in depth.** Instructions make mistakes rare; the guard catches the ones that still happen; the human review is the last line.
- **Pick the mode by the size of the job.** Inline edit is small, fast and works on weak models; agent mode finds its own context and edits many files.
