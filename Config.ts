// Config
// ======
// The server's settings. Its DIR ($UNII_DIR, default ~/.unii) holds
// config.json, the lock and users/<id>. Each key of config.json (README)
// may be set as UNII_<KEY> instead; a path may start with "~/". The keys
// are read from the environment and removed from it, so no program an
// agent runs inherits them, and put back for the workers.

import * as fs from "node:fs";
import * as os from "node:os";
import type { Vendor } from "./AskAI.ts";
import { LABELS, VENDORS, Pick, type Offer } from "./Pick.ts";

// Constants
// =========

export const DIR = config_path(process.env.UNII_DIR ?? "~/.unii");

const PATH = DIR + "/config.json";
const FILE: Record<string, string> = fs.existsSync(PATH) ? JSON.parse(fs.readFileSync(PATH, "utf8")) : {};

export const SITE    = config_get("site", "http://127.0.0.1:8788").replace(/\/$/, "");
// A personal loopback server can open its local chat without email sign-in.
export const LOCAL   = config_get("local", "0") === "1" && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(SITE).hostname);
export const T3      = LOCAL && config_get("t3", "0") === "1";
// The models offered default to every label, kept as an array: a local
// provider's label can itself hold a comma (a DSH model is a JSON pair), so
// joining the labels to split them again would cut it in pieces.
const MODELS = config_get("models", "");
export const OFFER: Offer = {
  vendors : config_vendors(config_get("vendors", T3 ? VENDORS.filter((v) => v.startsWith("t3-")).join() : "claude-api")),
  models  : MODELS === "" ? LABELS : MODELS.split(",").map((m) => m.trim()),
};

export const WORK       = config_path(config_get("work", DIR + "/work"));
export const RULES      = config_path(config_get("rules", ""));
export const AFTER      = config_get("after", "");
export const PICK       = config_run("pick", config_get("pick", T3 ? "t3-codex:gpt-6.1-sol:medium:slow" : "claude-api:sonnet-5.5:medium:slow"));

// what every compaction runs on first, a chat's and an import's alike,
// whatever the chat's pick
export const COMPACTOR  = config_run("compactor", config_get("compactor", T3 ? "t3-codex:gpt-6-luna:high:slow" : "claude-api:haiku-5.5:high:slow"));

// The ordered fallbacks: a small, fast, text-only model of the kind that
// suits a summary, never the chat's expensive pick. The primary above is
// tried first; these are tried in order if it is out of quota, gone, or
// silent. A local installation (T3) falls back to the free/cheap local
// providers; an API server to the other API adapter it offers.
const T3_COMPACTOR_FALLBACKS = [
  "t3-opencode:opencode/mimo-v2.6-flash-free:medium:slow",
  't3-dsh:["opendesign","deepseek-v4.1-flash"]:low:slow',
  't3-dsh:["deepseek-official","deepseek-flash"]:low:slow',
  't3-dsh:["opengateway","deepseek/deepseek-v4.1-flash-ultrafast"]:low:slow',
];
const API_COMPACTOR_FALLBACKS = [
  ...(OFFER.vendors.includes("openai-api") ? ["openai-api:gpt-6-luna:medium:slow"] : []),
  ...(OFFER.vendors.includes("claude-api") ? ["claude-api:haiku-5.5:high:slow"] : []),
];
export const COMPACTORS = config_compactors();
export const AGENTS     = config_get("agents", "") ? config_run("agents", config_get("agents", "")) : null;
export const WORKERS    = Number(config_get("workers", "0"));

// the iOS app (ios/, Cloud.ts): its App ID, the team's then the bundle's
// ("TEAM.com.example.uniichat"), whose app sign-in links open; and
// the id of the key its pushes are signed with (APNS_KEY holds the key)
export const APPLE      = config_get("apple", "");
export const APNS       = config_get("apns", "");

// the keys, by name, and the variable each is read from
const VARS: Record<string, string> = {
  anthropic       : "ANTHROPIC_API_KEY",
  openai          : "OPENAI_API_KEY",
  resend          : "RESEND_API_KEY",
  apns            : "APNS_KEY",
};
export const KEYS: Record<string, string> = Object.fromEntries(Object.entries(VARS).map(([name, v]) => [name, config_key(v)]));

// Config
// ======

export function config_get(key: string, def: string): string {
  return process.env["UNII_" + key.toUpperCase()] ?? FILE[key] ?? def;
}

function config_path(path: string): string {
  return path.startsWith("~/") ? os.homedir() + path.slice(1) : path;
}

function config_run(key: string, text: string): Pick {
  // ACP model ids may themselves contain colons (Hermes) or JSON arrays.
  const [vendor, ...parts] = text.split(":");
  const speed = parts.pop();
  const effort = parts.pop();
  const model = parts.join(":");
  const pick = Pick.read({ vendor, model, effort, speed }, OFFER);
  if (pick === null) {
    throw new Error("config: " + key + " is no vendor:model:effort:speed offered here: " + text);
  }
  return pick;
}

// the ordered chain of compactors: `compactors` (semicolon-separated)
// replaces the built-in one; otherwise the primary then the fallbacks of
// this installation (T3 local, or the API adapters offered)
function config_compactors(): Pick[] {
  const raw = config_get("compactors", "");
  const configured = typeof raw === "string" ? raw.trim() : "";
  const texts = configured
    ? configured.split(";").map((text) => text.trim()).filter(Boolean)
    : [Pick.label(COMPACTOR), ...(T3 ? T3_COMPACTOR_FALLBACKS : API_COMPACTOR_FALLBACKS)];
  const picks: Pick[] = [];
  for (const [k, text] of texts.entries()) {
    const vendor = text.split(":")[0] as Vendor;
    if (!OFFER.vendors.includes(vendor)) {
      if (k === 0) {
        throw new Error("config: compactor is no vendor offered here: " + text);
      }
      continue;
    }
    try {
      const pick = config_run(k === 0 ? "compactor" : "compactors", text);
      if (!picks.some((saved) => Pick.label(saved) === Pick.label(pick))) {
        picks.push(pick);
      }
    } catch (err: any) {
      if (k === 0) {
        throw err;
      }
      console.error("config: compactor fallback skipped: " + text + " (" + err.message + ")");
    }
  }
  if (picks.length === 0) {
    throw new Error("config: no compactor is offered here");
  }
  return picks;
}

function config_vendors(text: string): Vendor[] {
  const list = text.split(",").map((v) => v.trim()) as Vendor[];
  const bad = list.find((v) => !VENDORS.includes(v));
  if (bad !== undefined) {
    throw new Error("config: vendors can't offer " + bad);
  }
  return list;
}

function config_key(name: string): string {
  const key = (process.env[name] ?? "").trim();
  delete process.env[name];
  return key;
}

// the environment a worker of this server starts with: this one, with
// the keys back
export function config_env(): Record<string, string | undefined> {
  const keys = Object.entries(VARS).map(([name, v]) => [v, KEYS[name]]);
  return { ...process.env, ...Object.fromEntries(keys) };
}
