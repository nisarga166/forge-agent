# Forge-a-thon run log

Model names: primary = gemini-3-1-flash-lite (Gemini), backup = groq/qwen-27b (Qwen).
Bugs and fixes: see docs/ENGINEERING_LOG.md in the repo (20 rows). This file is only the run log.

## Rehearsal runs (not recorded)

| # | Date, time (IST) | Task | How | Model | Switched? | Time | Result | Checks |
|---|---|---|---|---|---|---|---|---|
| R1 | 18 Nov, 4:20 am | B (run 3) | Agent panel | Gemini | No | — | PASS | 3 files, 61 insertions, 0 deletions; 59 passed; `config` in --help; SECRET_KEY = *** |
| R2 | 18 Nov, ~4:40 pm | A | Agent panel (wrong mode) | Gemini | No | ~1 min | PASS, but not counted (Task A must be inline) | off/N/0 = False |
| R3 | 18 Nov, ~6:30 pm | A | Agent panel (wrong mode) | Qwen | Restarted | — | FAIL | 429, then "conversation too long", then bad tool call. Nothing changed (git status clean) |
| R4 | 18 Nov, ~6:40 pm | A | Inline, Ctrl+Alt+K | Qwen | No | ~10 s | PASS | yes = True; off/0/N = False |

## Recorded clips

| Clip | File | Date, time (IST) | Model | Switched? | Length | Result | Checks |
|---|---|---|---|---|---|---|---|
| A (backup) | A_inline_backup.mp4 | 18 Nov, 10:47 pm | Gemini | No | 38 s | PASS, but 720p and small font | off/N/0 = False, yes = True; Ctrl+Z → off = True; git status clean |
| A | A_inline.mp4 | 18 Nov, 10:55 pm | Gemini | No | 40 s | PASS (final) | same checks; 1080p; diff shown ~3 s |
| Cancel | A_cancel.mp4 | | | | | | |
| B | B_agent.mp4 | | | | | | 59 passed? config in --help? *** masking? 3+ files, 0 deletions? |
| C1 | C_resilience.mp4 | | Gemini (broken key) → Qwen | | | | notice shown? off = False? |
| C2 | C_resilience.mp4 | | Gemini (broken key), no backup | | | | clear message? editor responsive? git status clean? |

## Final video timestamps (fill after joining)

| Part | Starts at |
|---|---|
| Task A | |
| Cancel | |
| Task B | |
| Task B proofs (59 passed, --help, ***) | |
| Task C | |
| What broke and how we fixed it | |

## Things a judge might ask (my answers, in my words)

- Why does inline edit use no tools?
- Why retry once on a 429, but switch straight away on a bad key?
- Why is the watchdog paused while a tool runs?
- Why is the delete guard plain code and not just an instruction?
- When would inline edit give the wrong answer?
