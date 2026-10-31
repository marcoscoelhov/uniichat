// An explicit connectivity check makes one short model call per provider.
// It can consume subscription quota. No messages are added to the user's chat.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import catalog from "../t3-catalog.json";

process.env.UNII_LOCAL = "1";
process.env.UNII_T3 = "1";
const { LocalAgent } = await import("../LocalAgent.ts");
const { Pick } = await import("../Pick.ts");
const { DIR } = await import("../Config.ts");
const file = path.join(DIR, "t3-health.json");
const health = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const only = process.argv.slice(2);
for (const provider of catalog.providers) {
  if (only.length && !only.includes(provider.id)) continue;
  if (provider.status === "unavailable") continue;
  const model = provider.models.find((m) => m.id === health[provider.id]?.model) ?? provider.models.find((m: any) => !m.legacy) ?? provider.models[0];
  if (!model) continue;
  const vendor = `t3-${provider.id}` as const;
  const efforts = Pick.model(vendor, model.id)?.efforts ?? ["medium"];
  let text = "";
  const call = LocalAgent.ask({ vendor, model: model.id, effort: efforts.includes("low") ? "low" : efforts[0], speed: "slow", system: "Responda exatamente OK. Não use ferramentas.", blocks: [{ text: "Teste de conexão. Responda OK.", mark: false }], searches: 0, server: "" }, (event) => {
    if (event.$ === "Entry" && event.kind === "unii") text += event.text;
  });
  const timeout = setTimeout(() => call.stop(), 90000);
  const end = await call.done;
  clearTimeout(timeout);
  const ok = end.ok && /^OK[.!]?$/i.test(text.trim());
  health[provider.id] = { ok, checkedAt: new Date().toISOString(), model: model.id, detail: ok ? "Conexão testada · resposta recebida" : end.text || "O provedor respondeu, mas o teste não foi confirmado." };
  fs.writeFileSync(file, JSON.stringify(health, null, 2) + "\n", { mode: 0o600 });
  console.log(provider.name + ": " + health[provider.id].detail);
}
console.log("Atualize o seletor com bun run sync:t3 && bun run web e reinicie o servidor.");
