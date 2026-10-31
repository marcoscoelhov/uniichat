// Local provider transports. No credentials are copied: each installed CLI
// reads its own existing login. Commands always use argv, never a shell.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Runtime = { command: string[]; transport: string; env?: Record<string, string> };

export function launch(runtime: Runtime, cwd: string): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...runtime.env };
  // Do not make a CLI think it is nested inside this coding session.
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  return spawn(runtime.command[0], runtime.command.slice(1), { cwd, env, detached: true, stdio: "pipe" });
}

export function terminate(proc: ChildProcessWithoutNullStreams): void {
  if (proc.pid) {
    try { process.kill(-proc.pid, "SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { process.kill(-proc.pid!, "SIGKILL"); } catch {} }, 1000);
    timer.unref();
  }
}

export async function command(runtime: Runtime, cwd: string, input: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error("stopped");
  const proc = launch(runtime, cwd);
  const abort = () => terminate(proc);
  signal.addEventListener("abort", abort, { once: true });
  let out = "";
  let size = 0;
  let overflow = false;
  let diagnostics = "";
  proc.stderr.on("data", (chunk) => {
    // Classify known failures locally; never expose raw CLI diagnostics.
    diagnostics = (diagnostics + chunk.toString()).slice(-16384);
  });
  proc.stdout.on("data", (chunk) => {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) { overflow = true; terminate(proc); }
    else out += chunk.toString();
  });
  const done = new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", resolve);
  });
  proc.stdin.on("error", () => {});
  proc.stdin.end(input);
  try {
    const code = await done;
    if (signal.aborted) throw new Error("stopped");
    if (overflow) throw new Error("The local provider exceeded the output limit.");
    if (code !== 0) {
      const hint = diagnostics + out.slice(-16384);
      if (/insufficient balance|balance exhausted|402.*(?:balance|payment)|payment required/i.test(hint)) throw new Error("Sem saldo disponível no provedor. Verifique sua conta no T3 Code.");
      if (/invalid_grant|not logged in|unauthorized|authentication required|oauth refresh failed/i.test(hint)) throw new Error("Sessão expirada ou login necessário. Reconecte o provedor no T3 Code.");
      throw new Error("O provedor local falhou (exit " + code + "). Verifique a conexão no T3 Code.");
    }
    return out;
  } finally {
    signal.removeEventListener("abort", abort);
    terminate(proc);
  }
}

export class Acp {
  proc: ChildProcessWithoutNullStreams;
  pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  next = 0;
  closed = false;
  text = "";
  abort: () => void;

  constructor(runtime: Runtime, cwd: string, readonly signal: AbortSignal) {
    if (signal.aborted) throw new Error("stopped");
    this.proc = launch(runtime, cwd);
    this.proc.stderr.resume();
    this.proc.stdin.on("error", () => {});
    const lines = createInterface({ input: this.proc.stdout });
    lines.on("line", (line) => {
      try { this.hear(JSON.parse(line)); } catch {}
    });
    this.proc.once("error", () => this.fail("Could not start the local ACP provider."));
    this.proc.once("close", (code, signal) => this.fail("The ACP provider closed (" + (signal ?? "exit " + code) + "). Check the provider in T3 Code."));
    this.abort = () => this.close();
    signal.addEventListener("abort", this.abort, { once: true });
  }

  hear(msg: any): void {
    if (msg.method && msg.id !== undefined) {
      // Tools are executed by Unii's own loop, where their results are kept in
      // its memory. Never silently approve the provider's separate tool loop.
      const result = msg.method === "session/request_permission" ? { outcome: { outcome: "cancelled" } } : null;
      this.write(result ? { jsonrpc: "2.0", id: msg.id, result } : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Use UniiChat tools." } });
    } else if (msg.method === "session/update") {
      const update = msg.params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        this.text += update.content.text;
      }
    } else if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      // Protocol errors can include provider secrets; show only the code.
      if (msg.error) pending.reject(new Error("ACP request failed (" + msg.error.code + "). Check the provider in T3 Code."));
      else pending.resolve(msg.result);
    }
  }

  write(msg: object): void {
    if (!this.closed) this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  rpc(method: string, params: object, ms = 60000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("stopped"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ACP provider timed out: " + method));
        this.close();
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async start(cwd: string): Promise<any> {
    await this.rpc("initialize", { protocolVersion: 2, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "uniichat", version: "1" } });
    return this.rpc("session/new", { cwd, mcpServers: [] });
  }

  async pick(session: any, model: string, effort: string): Promise<void> {
    const configs = session.configOptions ?? [];
    const option = configs.find((c: any) => c.category === "model" || (c.configId ?? c.id) === "model");
    if (option) {
      await this.rpc("session/set_config_option", { sessionId: session.sessionId, configId: option.configId ?? option.id, value: model });
    } else if (session.models?.availableModels?.length) {
      await this.rpc("session/set_model", { sessionId: session.sessionId, modelId: model });
    } else if (model !== "default") {
      throw new Error("This ACP provider did not advertise model selection.");
    }
    const reasoning = configs.find((c: any) => /reason|effort|thinking/.test(c.configId ?? c.id ?? ""));
    if (reasoning) {
      const values = (reasoning.options ?? []).flatMap((o: any) => o.options ?? [o]);
      if (values.some((v: any) => v.value === effort)) {
        await this.rpc("session/set_config_option", { sessionId: session.sessionId, configId: reasoning.configId ?? reasoning.id, value: effort });
      }
    }
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    this.text = "";
    const result = await this.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 15 * 60000);
    if (result?.stopReason === "cancelled") throw new Error("stopped");
    if (result?.stopReason && result.stopReason !== "end_turn") throw new Error("The ACP provider ended before completing its answer (" + result.stopReason + ").");
    return this.text;
  }

  fail(message: string): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    this.fail("stopped");
    terminate(this.proc);
  }
}
