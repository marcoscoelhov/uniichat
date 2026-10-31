// Installed T3 providers supply completions; Unii retains its memory and tool
// loop. A fresh completion sees Unii's current tree view, never an unrelated
// CLI conversation. Provider credentials remain in their original stores.
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "./Agent.ts";
import type { Ask, End, Event, Say, Try } from "./AskAI.ts";
import * as config from "./Config.ts";
import { Acp, command, type Runtime } from "./LocalProcess.ts";

export function completion(raw: string, driver: string): string {
  if (!["codex", "opencode"].includes(driver)) return raw.trim();
  const chunks: string[] = [];
  for (const line of raw.split("\n")) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "error" || msg.type === "turn.failed") throw new Error("The local provider could not complete the request. Check it in T3 Code.");
    if (driver === "codex" && msg.type === "item.completed" && msg.item?.type === "agent_message") chunks.push(msg.item.text);
    if (driver === "opencode" && msg.type === "text") chunks.push(msg.part?.text ?? "");
  }
  return chunks.join("\n").trim();
}

export function argv(runtime: Runtime, ask: Ask, prompt: string, promptFile?: string): { runtime: Runtime; input: string } {
  let args: string[];
  let input = prompt;
  switch (runtime.transport) {
    case "codex": args = ["exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-m", ask.model, "-c", `model_reasoning_effort=${JSON.stringify(ask.effort)}`, "-"]; break;
    case "claudeAgent": args = ["--print", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--model", ask.model, "--effort", ask.effort]; break;
    case "grok": {
      if (!promptFile) throw new Error("Grok requires a temporary prompt file.");
      args = ["--prompt-file", promptFile, "--output-format", "plain", "--tools", "", "--no-subagents", "--model", ask.model, "--reasoning-effort", ask.effort];
      input = "";
      break;
    }
    case "pi": args = ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-context-files", "--no-skills", "--thinking", ask.effort, ...(ask.model === "default" ? [] : ["--model", ask.model])]; break;
    case "opencode": {
      // Linux caps the size of one argv entry; OpenCode joins message args.
      const parts = prompt.match(/[\s\S]{1,32000}/g) ?? [];
      args = ["run", "--format", "json", "--model", ask.model, "--", ...parts];
      input = "";
      break;
    }
    default: throw new Error("Unsupported local provider transport.");
  }
  const env = runtime.transport === "opencode" ? { ...runtime.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "deny" } }) } : runtime.env;
  return { runtime: { ...runtime, env, command: [...runtime.command, ...args] }, input };
}

export type Reply = { text: string; tool?: { name: string; input: unknown } };

export function reply(raw: string): Reply {
  const clean = raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "");
  let value: any;
  try { value = JSON.parse(clean); } catch {
    // A normal prose answer is still a valid final answer. Never interpret
    // tool-shaped JSON embedded in prose as an instruction to execute.
    return { text: raw.trim() };
  }
  if (typeof value.text !== "string") throw new Error("The provider returned an invalid response envelope.");
  if (value.tool != null && (typeof value.tool.name !== "string" || !value.tool.input || typeof value.tool.input !== "object")) {
    throw new Error("The provider returned an invalid tool request.");
  }
  return { text: value.text, ...(value.tool == null ? {} : { tool: value.tool }) };
}

export namespace LocalAgent {
  export function ask(ask: Ask, on: (ev: Event) => void): Try {
    const abort = new AbortController();
    const sent: Say[] = [];
    const end: End = { ok: false, text: "", left: sent };
    const run = { ask, on, sent, abort, end };
    const done = (async () => {
      let acp: Acp | undefined;
      try {
        if (!config.T3) throw new Error("Local T3 providers are enabled only with local=1 and t3=1.");
        if (ask.bill) throw new Error("Local subscription providers are unavailable on billed calls.");
        if (ask.imgs?.length) throw new Error("This local adapter currently accepts text. Use an API provider for image attachments.");
        const id = ask.vendor.slice(3);
        const runtimes = JSON.parse(fs.readFileSync(path.join(config.DIR, "t3-runtimes.json"), "utf8"));
        const runtime: Runtime | undefined = runtimes[id];
        if (!runtime) throw new Error("Local provider missing. Run bun run sync:t3.");
        const cwd = path.join(config.DIR, "providers");
        fs.mkdirSync(cwd, { recursive: true });
        const tools = await Agent.server(run);
        const protocol = tools.length ? '\n\nUNIICHAT RESPONSE PROTOCOL:\nYour native tools are disabled. Use only the tools listed below, through this JSON response protocol. Return exactly one JSON object, no markdown fences:\n{"text":"message for the user", "tool":null}\nor {"text":"optional explanation", "tool":{"name":"exact tool name", "input":{...}}}.\nUse one tool at a time. Its result follows, then you can use another. When finished, tool must be null. Do not invent results. Tool JSON is protocol, never show it as prose.\nTools:\n' + JSON.stringify(tools) : "";
        const history = [ask.system + protocol, ...ask.blocks.map((b) => b.text)];
        let session: any;
        if (runtime.transport === "acp") {
          acp = new Acp(runtime, cwd, abort.signal);
          session = await acp.start(cwd);
          await acp.pick(session, ask.model, ask.effort);
        }
        for (let step = 0; step < 100; step++) {
          if (abort.signal.aborted) throw new Error("stopped");
          const prompt = history.join("\n\n");
          let raw: string;
          const promptFile = runtime.transport === "grok" ? path.join(cwd, ".prompt-" + crypto.randomUUID()) : undefined;
          try {
            if (promptFile) fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
            const invocation = runtime.transport === "acp" ? null : argv(runtime, ask, prompt, promptFile);
            raw = acp ? await acp.prompt(session.sessionId, step === 0 ? prompt : history.slice(-2).join("\n\n")) : completion(await command(invocation!.runtime, cwd, invocation!.input, AbortSignal.any([abort.signal, AbortSignal.timeout(15 * 60000)])), runtime.transport);
          } finally { if (promptFile) fs.rmSync(promptFile, { force: true }); }
          if (!raw.trim()) throw new Error("The local provider returned no answer. Check its authentication in T3 Code.");
          if (abort.signal.aborted) throw new Error("stopped");
          const out = tools.length ? reply(raw) : { text: raw };
          if (out.text) {
            on({ $: "Delta", kind: "unii", text: out.text, fresh: true });
            on({ $: "Entry", kind: "unii", text: out.text });
          }
          history.push("Assistant: " + raw);
          if (out.tool) {
            const of = crypto.randomUUID();
            on({ $: "Entry", kind: "tool", text: out.tool.name + " " + JSON.stringify(out.tool.input), of });
            const result = await Agent.use(run, tools, { id: of, name: out.tool.name, input: out.tool.input });
            on({ $: "Entry", kind: "echo", text: (result.fail ? "error: " : "") + result.text, of });
            history.push("Tool result: " + JSON.stringify({ name: out.tool.name, ...result }));
          }
          if (sent.some((s) => s.imgs.length)) throw new Error("This local adapter currently accepts text only.");
          const queued = sent.splice(0);
          if (queued.length) {
            for (const say of queued) on({ $: "Entry", kind: "user", text: say.text });
            history.push("New user messages:\n" + queued.map((s) => s.text).join("\n\n"));
          }
          if (!out.tool && queued.length === 0) { end.ok = true; end.text = out.text; return end; }
        }
        throw new Error("The local provider reached the 100-step tool limit.");
      } catch (err: any) {
        end.text = err.message;
        // Failures of credentials or transport are not content refusals: the
        // memory must never replace a summary with clipped text because a
        // local CLI is unavailable. Transient outages retain patient retries.
        const setup = /Sem saldo|Sessão expirada|enabled only|provider missing|billed calls|accepts text|invalid response envelope|invalid tool request|Unsupported local|100-step/i.test(err.message);
        end.stop = abort.signal.aborted || setup ? "lost" : "down";
        return end;
      } finally { acp?.close(); }
    })();
    return { send: (say) => sent.push(say), stop: () => abort.abort(), done };
  }
}
