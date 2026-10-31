// Import public model metadata and command paths only. Never read auth files.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Acp, command, type Runtime } from "../LocalProcess.ts";

const home = os.homedir();
const t3 = process.env.T3CODE_HOME ?? path.join(home, ".t3");
const unii = process.env.UNII_DIR ?? path.join(home, ".unii");
const read = (p: string, fallback: any = {}) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
const settings = read(path.join(t3, "userdata/settings.json"));
const manifest = read(path.join(t3, "userdata/model-manifest.json")).manifest ?? {};
const cwd = path.join(unii, "providers");
fs.mkdirSync(cwd, { recursive: true });
const runtimes: Record<string, Runtime> = {};
const providers: any[] = [];
const health = read(path.join(unii, "t3-health.json"));
const builtins: Record<string, any> = {
  codex: { driver: "codex", displayName: "Codex", enabled: true },
  claudeAgent: { driver: "claudeAgent", displayName: "Claude", enabled: true },
};

for (const [id, instance] of Object.entries({ ...builtins, ...settings.providerInstances }) as [string, any][]) {
  if (!instance.enabled) continue;
  const driver = instance.driver;
  const executable = ({ codex: "codex", claudeAgent: "claude", grok: "grok", opencode: "opencode", pi: "pi" } as Record<string, string>)[driver];
  let runtime: Runtime | undefined;
  if (executable && Bun.which(executable)) runtime = { command: [Bun.which(executable)!], transport: driver };
  if (driver === "acpRegistry" && instance.config?.commandPath) {
    runtime = { command: [instance.config.commandPath, ...(instance.config.commandArgs ?? [])], transport: "acp" };
  }
  if (driver === "antigravity") {
    const base = path.join(t3, "tools/antigravity-acp", `${process.platform}-${process.arch}`);
    const active = read(path.join(base, "active.json"));
    const dir = path.join(base, "versions", active.releaseId ?? "missing");
    const profile = path.join(t3, "userdata/providers/antigravity", createHash("sha256").update(id).digest("hex"));
    if (fs.existsSync(path.join(dir, "agy_acp_server.par"))) {
      runtime = { command: [path.join(dir, "agy_acp_server.par"), "--uid="], transport: "acp", env: {
        GEMINI_HOME: profile, AGY_ACP_FORCE_FILE_STORAGE: "1", ANTIGRAVITY_HARNESS_PATH: path.join(dir, "localharness_external"),
        PYTHONUNBUFFERED: "1", ELECTRON_RUN_AS_NODE: "1", BROWSER: "/bin/false", SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      } };
    }
  }
  if (!runtime || !fs.existsSync(runtime.command[0])) {
    providers.push({ id, name: instance.displayName ?? id, status: "unavailable", detail: "Executável local não encontrado", models: [] });
    continue;
  }
  runtimes[id] = runtime;
  let models: any[] = (manifest.providers?.[driver]?.models ?? []).map((m: any) => ({ id: m.slug, label: m.name ?? m.slug, legacy: m.status === "legacy" }));
  let detail = "Instalado · autenticação do próprio provedor";
  let status = "configured";
  try {
    if (driver === "codex") {
      const cache = read(path.join(home, ".codex/models_cache.json"));
      for (const m of (cache.models ?? []).filter((m: any) => m.visibility !== "hide")) {
        const at = models.findIndex((x) => x.id === m.slug);
        const model = { id: m.slug, label: m.display_name ?? m.slug, efforts: (m.supported_reasoning_levels ?? []).map((o: any) => o.effort), legacy: false };
        if (at < 0) models.push(model); else models[at] = { ...models[at], ...model };
      }
    } else if (driver === "grok") {
      models = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"].map((id) => ({ id, label: id, efforts: ["low", "medium", "high", ...(id === "grok-4.5" ? [] : ["xhigh"])] }));
    } else if (driver === "opencode") {
      const out = await command({ ...runtime, command: [...runtime.command, "models"] }, cwd, "", AbortSignal.timeout(45000));
      models = out.trim().split("\n").filter((s) => /^[\w.-]+\/[^\s]+$/.test(s)).map((id) => ({ id, label: id.split("/").slice(1).join("/") }));
    } else if (driver === "pi") {
      models = [{ id: "default", label: "Padrão do Pi", efforts: ["low", "medium", "high", "xhigh", "max"] }];
    } else if (runtime.transport === "acp") {
      const client = new Acp(runtime, cwd, AbortSignal.timeout(60000));
      try {
        const session = await client.start(cwd);
        const modelOption = (session.configOptions ?? []).find((c: any) => c.category === "model" || (c.configId ?? c.id) === "model");
        // A grouped catalog (DSH serves several routes) keeps the group's
        // name in the label, so the selector says which account answers.
        const options = (modelOption?.options ?? []).flatMap((o: any) =>
          (o.options ?? [o]).map((entry: any) => ({ entry, group: o.options ? (o.name ?? o.group) : undefined })));
        const found = (session.models?.availableModels ?? []).map((m: any) => ({ id: m.modelId, label: m.name ?? m.modelId }));
        for (const { entry: o, group } of options) {
          if (!o.value || found.some((m: any) => m.id === o.value)) continue;
          const name = o.name ?? o.label ?? o.value;
          const shown = ({ "DeepSeek": "DeepSeek oficial", "DeepSeek Account": "DeepSeek conta" } as Record<string, string>)[group ?? ""] ?? group;
          found.push({ id: o.value, label: shown && !String(name).startsWith(shown + " · ") ? shown + " · " + name : name });
        }
        const reasoning = (session.configOptions ?? []).find((c: any) => /reason|effort|thinking/.test(c.configId ?? c.id ?? ""));
        const efforts = (reasoning?.options ?? []).flatMap((o: any) => o.options ?? [o]).map((o: any) => o.value).filter((v: any) => typeof v === "string" && !v.startsWith("_t3/"));
        // DSH's models do not share one effort set: Open Gateway and Open
        // Design offer off/high/max, the DeepSeek routes also low. Keep the
        // catalog to what every route accepts; a per-model list would need
        // one session per model.
        const safe = id === "dsh" ? ["off", "high", "max"] : efforts;
        if (found.length) models = found.map((m: any) => ({ ...m, ...(safe.length ? { efforts: safe } : {}) }));
        else if (!models.length) models = [{ id: "default", label: "Padrão do provedor" }];
        detail = "ACP conectado · catálogo consultado";
        status = "ready";
      } finally { client.close(); }
    }
  } catch (err: any) {
    detail = err.message.includes("SIGKILL") ? "Processo ACP encerrado pelo sistema (SIGKILL)." : err.message;
    status = "needs-attention";
  }
  if (driver === "claudeAgent") models = models.map((m) => ({ ...m, efforts: ["low", "medium", "high", "xhigh", "max"] }));
  if (!models.length) models = [{ id: "default", label: "Padrão do provedor" }];
  const checked = health[id];
  if (checked && typeof checked.checkedAt === "string" && typeof checked.detail === "string") {
    status = checked.ok ? "ready" : "needs-attention";
    detail = checked.detail;
  }
  providers.push({ id, name: instance.displayName ?? id, status, detail, ...(checked ? { checkedAt: checked.checkedAt, testedModel: checked.model } : {}), models });
  console.log(`${instance.displayName ?? id}: ${models.length} modelos (${status})`);
}

const catalog = { syncedAt: new Date().toISOString(), providers };
fs.writeFileSync(path.join(import.meta.dir, "../t3-catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
fs.writeFileSync(path.join(unii, "t3-runtimes.json"), JSON.stringify(runtimes, null, 2) + "\n", { mode: 0o600 });
console.log("Catálogo público atualizado; caminhos locais salvos separadamente em ~/.unii.");
