// Talks to TrueForge (the agent harness running on your laptop).
// The extension NEVER calls a model directly: TrueForge does that.
//
// Day 6 (Task C): what happens when the model breaks.
//   1. A temporary error (429 rate limit, timeout, 5xx) gets ONE retry after a short wait.
//   2. If that fails too, or the error is permanent (bad key, unknown model), we switch the
//      SAME conversation to the backup model and continue. History is kept.
//   3. A watchdog notices when the model goes silent for too long (but not while a tool runs,
//      because a tool may be waiting for YOU to click Accept).
//   4. A step limit stops an agent that loops forever.
// Every switch is shown in the panel, so the user always knows which model is answering.
import { TrueForge } from "@truefoundry/trueforge-sdk";

export interface TurnCallbacks {
  onToken: (text: string) => void;          // a few words arrived
  onTool: (line: string) => void;           // the agent used a tool (shown in the panel)
  onDone: (status: string, info: string) => void; // turn finished: done / cancelled / error
  onNotice?: (line: string) => void;        // retry / fallback messages
  onRestart?: () => void;                   // a new attempt starts: throw away partial text
}

export interface FallbackOptions {
  backupModel?: string;   // e.g. "groq/qwen-27b" ("provider name/model name" as in TrueForge). Empty = no fallback.
  retryDelayMs?: number;  // wait before the one retry on a temporary error
  stallSeconds?: number;  // no event for this long (while no tool is running) = model is stuck
  maxSteps?: number;      // agent-loop limit per turn (TrueForge "iterationLimit")
  resend?: "continue" | "original"; // after a failure: ask to continue (chat) or send the request again (inline edit)
}

// Files the user accepted edits to in this conversation (filled in by the extension).
// Used to tell a fresh conversation what was already done.
export const editedFiles = new Set<string>();

type Result = { status: "done" | "cancelled" | "error"; info: string };

const CONTINUE_MSG =
  "The previous attempt stopped because of a model error. Continue the task from where you stopped. " +
  "Do not redo edits that were already made: read_file again before changing a file you already edited.";

export class ForgeClient {
  private client: TrueForge;
  private sessionId: string | undefined;
  private inline = false;          // true = we hold the agent spec ourselves, so we can swap the model
  private spec: any;
  private usingBackup = false;
  private userCancelled = false;
  private opts: Required<FallbackOptions>;

  constructor(baseUrl: string, private agentName: string, opts: FallbackOptions = {}) {
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });
    this.opts = {
      backupModel: opts.backupModel ?? "",
      retryDelayMs: opts.retryDelayMs ?? 5000,
      stallSeconds: opts.stallSeconds ?? 120,
      maxSteps: opts.maxSteps ?? 60,
      resend: opts.resend ?? "continue",
    };
  }

  // Which model is answering right now (shown in the panel).
  get currentModel(): string {
    return this.spec?.model?.name ?? this.agentName;
  }

  // One session = one conversation. We create it the first time it is needed.
  // We copy the saved agent's settings into the session ("inline"), because TrueForge only lets
  // us change the model of an inline session, not of a session that just names a saved agent.
  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    try {
      const page: any = await this.client.agents.list();
      const agents: any[] = page?.data ?? [];
      const saved = agents.find((a) => a.name === this.agentName);
      if (!saved) throw new Error(`No agent named "${this.agentName}" in TrueForge.`);
      this.spec = structuredClone(saved.manifest);
      this.spec.config = { ...(this.spec.config ?? {}), iterationLimit: this.opts.maxSteps };
      const res = await this.client.sessions.create({ agent: { spec: this.spec } });
      this.sessionId = res.data.id;
      this.inline = true;
    } catch (err: any) {
      if (String(err?.message).startsWith("No agent named")) throw err;
      // Older TrueForge or listing failed: still work, just without model switching.
      const res = await this.client.sessions.create({ agent: { name: this.agentName } });
      this.sessionId = res.data.id;
      this.inline = false;
    }
    return this.sessionId!;
  }

  // Send one message. Retries and falls back to the backup model if the model breaks.
  // The ladder: 1) retry same model  2) switch the SAME conversation to the backup
  //             3) if the backup cannot read that conversation, give the backup a FRESH conversation
  //             4) stop with a clear message.
  async sendMessage(text: string, cb: TurnCallbacks): Promise<void> {
    this.userCancelled = false;
    const notice = (l: string) => (cb.onNotice ?? cb.onTool)(l);
    let input = text;
    let retried = false;
    let freshTried = false;

    for (;;) {
      const r = await this.runOnce(input, cb);
      if (r.status !== "error" || this.userCancelled) {
        cb.onDone(this.userCancelled ? "cancelled" : r.status, r.info);
        return;
      }
      const reason = explain(r.info);
      const next = this.opts.resend === "continue" ? CONTINUE_MSG : text;

      // Step 0: the conversation is too long for the model. Waiting does not shorten it, and a
      // smaller backup would fail even sooner. So start a fresh conversation on the SAME model,
      // with the task and the list of files already changed.
      if (isContextTooLong(r.info) && !freshTried && this.inline) {
        freshTried = true;
        try {
          const res = await this.client.sessions.create({ agent: { spec: this.spec } });
          this.sessionId = res.data.id;
          notice(`↪ The conversation got too long for ${this.currentModel}. Starting a fresh conversation with the task and the files already changed.`);
          cb.onRestart?.();
          input = this.opts.resend === "continue" ? handoff(text) : text;
          continue;
        } catch (e: any) {
          notice(`⚠ Could not start a fresh conversation: ${explain(errText(e))}`);
        }
      }

      // Step 1: a temporary problem on the main model gets one retry, after the wait the provider asks for.
      if (!retried && !this.usingBackup && isTemporary(r.info)) {
        retried = true;
        const wait = waitSeconds(r.info, this.opts.retryDelayMs / 1000);
        notice(`⚠ ${this.currentModel} failed: ${reason}. Retrying in ${wait} s…`);
        await sleep(wait * 1000);
        if (this.userCancelled) { cb.onDone("cancelled", ""); return; }
        cb.onRestart?.();
        input = next;
        continue;
      }
      // Step 2: switch this conversation to the backup model (keeps the history).
      if (!this.usingBackup && this.inline && this.opts.backupModel && this.opts.backupModel !== this.currentModel) {
        const from = this.currentModel;
        try {
          this.spec = { ...this.spec, model: { ...this.spec.model, name: this.opts.backupModel } };
          await this.client.sessions.update(this.sessionId!, { agent: { spec: this.spec } });
          this.usingBackup = true;
          notice(`↪ ${from} failed (${reason}). Switched to backup model ${this.opts.backupModel}; continuing the same conversation.`);
          cb.onRestart?.();
          input = next;
          continue;
        } catch (e: any) {
          this.usingBackup = true; // the spec already names the backup; go to step 3
          notice(`⚠ Could not switch the conversation: ${explain(errText(e))}`);
        }
      }
      // Step 3: the backup could not continue the old conversation (for example it rejects
      // messages written by another model). Start a fresh conversation with the same task.
      if (this.usingBackup && !freshTried && this.inline && !isTemporary(r.info)) {
        freshTried = true;
        try {
          const res = await this.client.sessions.create({ agent: { spec: this.spec } });
          this.sessionId = res.data.id;
          notice(`↪ ${this.currentModel} could not read the old conversation (${reason}). Starting a fresh conversation with the same task.`);
          cb.onRestart?.();
          input = this.opts.resend === "continue" ? handoff(text) : text;
          continue;
        } catch (e: any) {
          notice(`⚠ Could not start a fresh conversation: ${explain(errText(e))}`);
        }
      }
      // Step 4: give up clearly.
      const tips = !this.opts.backupModel
        ? " Tip: set a backup model (setting forge.backupModel)."
        : this.usingBackup ? " The backup model failed too." : "";
      cb.onDone("error", `${this.currentModel} failed: ${reason}.${tips} Edits you already accepted are kept; Ctrl+Z undoes them. Try again in a minute.`);
      return;
    }
  }

  // One attempt: stream one turn and report how it ended. Never throws.
  private async runOnce(text: string, cb: TurnCallbacks): Promise<Result> {
    let stalled = false;
    let toolsRunning = 0;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (toolsRunning > 0) return; // a tool may be waiting for the user: never time out here
      timer = setTimeout(() => { stalled = true; this.client.sessions.cancel(this.sessionId!).catch(() => {}); },
        this.opts.stallSeconds * 1000);
    };

    try {
      const sessionId = await this.ensureSession();
      const stream = await this.client.sessions.createTurnStream(sessionId, {
        input: [{ type: "user.message", content: text }],
      });
      arm();
      let calls: { name: string; args: string }[] = [];
      for await (const event of stream) {
        if (event.type === "model.message") {
          calls = []; // a new model reply starts
        } else if (event.type === "model.message.delta") {
          if (event.content) cb.onToken(event.content);
          // Tool calls arrive in pieces: the first piece has the name, later pieces add the arguments.
          for (const piece of event.toolCalls ?? []) {
            const i = piece.index ?? 0;
            calls[i] ??= { name: "", args: "" };
            if (piece.function?.name) calls[i].name = piece.function.name;
            if (piece.function?.arguments) calls[i].args += piece.function.arguments;
          }
          if (event.finishReason === "tool_calls") {
            for (const c of calls) if (c) { cb.onTool(`🔧 ${c.name}(${shorten(c.args, 120)})`); toolsRunning++; }
          }
        } else if (event.type === "tool.response") {
          toolsRunning = Math.max(0, toolsRunning - 1);
          cb.onTool(`   ↳ ${shorten(event.content, 160)}`);
        } else if (event.type === "tool.approval_required") {
          cb.onTool("⚠ TrueForge is waiting for tool approval. For now, turn OFF 'require approval' on the forge-editor-tools connector (the extension asks you itself).");
        } else if (event.type === "turn.done") {
          clearTimeout(timer);
          const s: any = event.state;
          if (stalled) return { status: "error", info: `no reply for ${this.opts.stallSeconds} s (timeout)` };
          if (s.status === "error") return { status: "error", info: String(s.message ?? "unknown error") };
          if (s.status === "cancelled") return { status: "cancelled", info: String(s.reason ?? "") };
          return { status: "done", info: "" };
        }
        arm();
      }
      clearTimeout(timer);
      return stalled
        ? { status: "error", info: `no reply for ${this.opts.stallSeconds} s (timeout)` }
        : { status: "error", info: "the connection to TrueForge closed early" };
    } catch (err: any) {
      clearTimeout(timer);
      if (this.userCancelled) return { status: "cancelled", info: "" };
      const t = errText(err);
      // TrueForge itself not running is not a model problem: no point switching models.
      if (/ECONNREFUSED|fetch failed/i.test(t) && !this.sessionId) throw err;
      return { status: "error", info: t };
    }
  }

  // Stop the running turn. TrueForge then ends the stream with turn.done (cancelled).
  async cancel(): Promise<void> {
    this.userCancelled = true;
    if (this.sessionId) await this.client.sessions.cancel(this.sessionId).catch(() => {});
  }

  // Start a fresh conversation next time (back on the primary model).
  reset(): void {
    this.sessionId = undefined;
    this.usingBackup = false;
    this.spec = undefined;
    editedFiles.clear();
  }
}

// ---------- helpers (plain functions, easy to test) ----------

// What the backup gets in a fresh conversation: the task, plus a warning that work may be half done.
export function handoff(task: string): string {
  const done = [...editedFiles];
  return task + "\n\nNote: an earlier attempt at this task was interrupted. " +
    (done.length ? `These files were already changed: ${done.join(", ")}. ` : "Some files may already be changed. ") +
    "Before editing a file, read_file it and do not add anything that is already there.";
}

// The conversation no longer fits in the model's context window.
export function isContextTooLong(info: string): boolean {
  return /context.?(length|window)|maximum context|too many tokens|prompt is too long|input token count|request too large|\b413\b/i.test(info);
}

// How long to wait before retrying. Providers often say it: "try again in 5.32s", "retryDelay": "37s".
export function waitSeconds(info: string, fallback: number): number {
  const m = /(?:try again in|retry in|retry after|retryDelay\W+)\s*([\d.]+)\s*s/i.exec(info);
  const s = m ? Math.ceil(parseFloat(m[1])) + 1 : fallback;
  return Math.min(Math.max(s, 5), 65);
}

// Temporary = worth waiting and trying again on the same model.
export function isTemporary(info: string): boolean {
  if (isContextTooLong(info)) return false;
  return /\b(429|500|502|503|504)\b|rate.?limit|quota|overloaded|timeout|timed out|ECONNRESET|ETIMEDOUT|temporar|unavailable/i.test(info);
}

// One short, human sentence for the panel.
export function explain(info: string): string {
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(info)) return "rate limit reached (429)";
  if (isContextTooLong(info)) return "the conversation is too long for the model";
  if (/\b400\b|invalid.?request|must be satisfied/i.test(info)) return "the model rejected the request (400)";
  if (/\b401\b|\b403\b|api.?key|unauthori[sz]ed|permission/i.test(info)) return "the API key was rejected";
  if (/\b404\b|not.?found|does not exist|unknown model/i.test(info)) return "the model was not found";
  if (/timeout|timed out|no reply/i.test(info)) return shorten(info, 80);
  if (/\b5\d\d\b|overloaded|unavailable/i.test(info)) return "the model provider is down or overloaded";
  return shorten(info, 120);
}

function errText(err: any): string {
  const code = err?.statusCode ? `${err.statusCode} ` : "";
  const body = err?.body?.error?.message ?? err?.body?.message ?? err?.message ?? String(err);
  return code + String(body);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Keep tool lines readable: one line, cut long text.
function shorten(text: unknown, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
