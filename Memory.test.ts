// Memory test
// ===========
// `bun test Memory.test.ts`. The real Memory, AskAI and Agent loop write a
// tree against a fake Anthropic that answers every compaction with the
// children it was given. A chat builds bottom-up, its view covers every
// message, a restart reads the same tree and view from disk, messages
// after it extend both, and a view over its high-water mark merges to
// fewer, broader lines without losing a message.

import { beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-memory-");
process.env.UNII_DIR = DIR;

const config = await import("./Config.ts");
config.KEYS.anthropic = "test";

const { Memory } = await import("./Memory.ts");
const { MASTER } = await import("./Tools.ts");

const PICK = { vendor: "claude-api" as const, model: "claude-opus-5-5", effort: "medium", speed: "slow" };
const SHARE = { ...PICK, system: MASTER, searches: 0, server: "" };

// Fake Anthropic
// ==============

// a streamed answer: its text, how it stopped
function answer(text: string, stop = "end_turn"): Response {
  const events = [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""));
}

// a line of 400 bytes: a pair of them is over NODE, so every merge asks
function line(prefix: string): string {
  return prefix + " " + "x".repeat(400 - prefix.length - 1);
}

let hold = 0;
let long = 0;
let longCalls = 0;
let failModel = "";
const calls: Record<string, number> = {};

// a compaction that takes `hold` ms, cut at once when its call is stopped
function held(init: any): Promise<void> {
  if (hold === 0) {
    return Promise.resolve();
  }
  return new Promise((ok, no) => {
    const timer = setTimeout(ok, hold);
    init.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      no(new Error("aborted"));
    }, { once: true });
  });
}

const real = globalThis.fetch;
const fake = (async (url: string, init: any) => {
  if (String(url).includes("count_tokens")) {
    return Response.json({ input_tokens: 1 });
  }
  const body = JSON.parse(init.body);
  calls[body.model] = (calls[body.model] ?? 0) + 1;
  if (body.model === failModel) {
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "usage limit" } }, { status: 400 });
  }
  const texts = body.messages[0].content.map((block: any) => block.text);
  const task: string = texts.findLast((text: string) => text.startsWith("Compaction:")) ?? texts.at(-1);
  await held(init);
  if (long > 0) {
    long -= 1;
    longCalls += 1;
    return answer("z".repeat(600));
  }
  const leaf = /Compaction: compress message (\d+)/.exec(task);
  if (leaf) {
    return answer(line("leaf " + leaf[1]));
  }
  const merge = /Compaction: merge lines (\d+)\+(\d+) and (\d+)\+(\d+)/.exec(task);
  if (merge) {
    return answer(line("merge " + merge.slice(1).join("+")));
  }
  return answer("ok");
}) as any;

beforeEach(() => {
  hold = 0;
  long = 0;
  longCalls = 0;
  failModel = "";
  for (const key of Object.keys(calls)) delete calls[key];
  globalThis.fetch = fake;
});

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}

// every node whose whole span is in the chat: level 0 is each message
function span(l: number, i: number): { from: number; to: number } {
  return { from: i * 2 ** l, to: (i + 1) * 2 ** l };
}

function nodes(count: number): Array<{ l: number; i: number }> {
  const out: Array<{ l: number; i: number }> = [];
  for (let l = 0; 2 ** l <= count; l++) {
    for (let i = 0; i < Math.ceil(count / 2 ** l); i++) {
      if (span(l, i).to <= count) {
        out.push({ l, i });
      }
    }
  }
  return out;
}

async function complete(mem: any, count: number): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (nodes(count).every(({ l, i }) => Memory.node(mem, { l, i }) !== null)) {
      return;
    }
    await sleep(5);
  }
  throw new Error("the tree did not complete");
}

// what the fake vendor should have written for a node
function wanted(l: number, i: number): string {
  if (l === 0) {
    return line("leaf " + i);
  }
  const n = 2 ** (l - 1);
  const a = i * 2 ** l;
  return line("merge " + [a, n, a + n, n].join("+"));
}

function viewParts(mem: any): Array<[number, number]> {
  return mem.view.parts.map((part: any) => [part.l, part.i]);
}

test("the tree builds bottom-up, survives a restart, and keeps growing", async () => {
  const count = 40;
  const dir = DIR + "/chat";
  const mem = Memory.load(dir, () => SHARE);
  Memory.push(mem, Array.from({ length: count }, (_, i) => ({ kind: "unii" as const, text: "message " + i + " " + "word ".repeat(160) })));
  await complete(mem, count);

  for (const { l, i } of nodes(count)) {
    expect(Memory.node(mem, { l, i })).toBe(wanted(l, i));
  }
  expect(Memory.end(mem.view)).toBe(count);
  expect(mem.view.parts.every((part: any) => Memory.node(mem, part) !== null)).toBe(true);

  // a line above the view opens into the two it was made from, down to them
  const part = { l: 3, i: 0 };
  const halves = Memory.halves(part);
  expect(Memory.source(mem, part.l, part.i)).toBe(Memory.flat(Memory.node(mem, halves[0])!) + "\n" + Memory.flat(Memory.node(mem, halves[1])!));

  const before = { count: mem.count, nodes: nodes(count).map(({ l, i }) => [l, i, Memory.node(mem, { l, i })]), parts: viewParts(mem), size: mem.view.size };
  Memory.stop(mem);

  const again = Memory.load(dir, () => SHARE);
  expect(again.count).toBe(before.count);
  expect(nodes(count).map(({ l, i }) => [l, i, Memory.node(again, { l, i })])).toEqual(before.nodes);
  expect(viewParts(again)).toEqual(before.parts);
  expect(again.view.size).toBe(before.size);
  expect(Memory.saved(dir)?.parts).toEqual(before.parts);

  // messages after a restart extend the tree without rewriting what was
  Memory.push(again, Array.from({ length: 5 }, (_, k) => ({ kind: "unii" as const, text: "later " + k + " " + "word ".repeat(160) })));
  await complete(again, count + 5);
  expect(again.count).toBe(count + 5);
  expect(Memory.end(again.view)).toBe(count + 5);
  for (const { l, i } of nodes(count)) {
    expect(Memory.node(again, { l, i })).toBe(wanted(l, i));
  }
  for (let i = count; i < count + 5; i++) {
    expect(Memory.node(again, { l: 0, i })).toBe(line("leaf " + i));
  }
  Memory.stop(again);
});

test("a view over its high-water mark merges to fewer lines, covering all", async () => {
  const count = 32;
  const dir = DIR + "/view";
  const mem = Memory.load(dir, () => SHARE);
  // the production threshold is 128 KB; lower it here so 20 short lines
  // exercise the same path without a chat of hundreds of messages
  mem.view.high = 1000;
  mem.seen.high = 1000;
  Memory.push(mem, Array.from({ length: count }, (_, i) => ({ kind: "unii" as const, text: "message " + i + " " + "word ".repeat(160) })));
  await complete(mem, count);

  for (let tries = 0; tries < 12 && mem.view.size > mem.view.high; tries++) {
    Memory.fit(mem, true);
  }
  expect(mem.view.parts.length).toBeLessThan(count);
  expect(mem.view.size).toBeLessThanOrEqual(mem.view.high);
  expect(Memory.end(mem.view)).toBe(count);
  expect(mem.view.parts.every((part: any) => Memory.node(mem, part) !== null)).toBe(true);
  expect(mem.view.parts.every((part: any, k: number) => k === 0 || Memory.end({ parts: [mem.view.parts[k - 1]], size: 0, batch: false, high: 0 }) <= part.i * 2 ** part.l)).toBe(true);
  Memory.stop(mem);
});

// leave the real fetch to the rest of the suite
globalThis.fetch = real;

test("a restart with compactions running resumes without duplicate nodes", async () => {
  const count = 10;
  const dir = DIR + "/restart";
  hold = 300;
  const mem = Memory.load(dir, () => SHARE);
  Memory.push(mem, Array.from({ length: count }, (_, i) => ({ kind: "unii" as const, text: "message " + i + " " + "word ".repeat(160) })));
  await sleep(60);
  // the summaries are running, not yet written
  expect(mem.busy.size).toBeGreaterThan(0);
  Memory.stop(mem);
  await sleep(400);

  hold = 0;
  const again = Memory.load(dir, () => SHARE);
  Memory.pump(again);
  await complete(again, count);
  for (const { l, i } of nodes(count)) {
    expect(Memory.node(again, { l, i })).toBe(wanted(l, i));
  }
  const day = fs.readdirSync(dir + "/tree")[0];
  const lines = fs.readFileSync(dir + "/tree/" + day, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const keys = lines.map((rec: any) => rec.l + "/" + rec.i);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.length).toBe(nodes(count).length);
  Memory.stop(again);
});

test("a line over the limit is asked again, and the fitting one is kept", async () => {
  const dir = DIR + "/long";
  long = 1;
  const mem = Memory.load(dir, () => SHARE);
  Memory.push(mem, [{ kind: "unii" as const, text: "message " + "word ".repeat(160) }]);
  await complete(mem, 1);
  expect(longCalls).toBe(1);
  expect(Memory.node(mem, { l: 0, i: 0 })).toBe(line("leaf 0"));
  expect(Buffer.byteLength(Memory.node(mem, { l: 0, i: 0 })!)).toBe(400);
  Memory.stop(mem);
});

test("a compactor that fails falls back to the next", async () => {
  const dir = DIR + "/fallback";
  const original = [...config.COMPACTORS];
  const primary = { vendor: "claude-api" as const, model: "opus-5.5", effort: "medium", speed: "slow" };
  const fallback = { vendor: "claude-api" as const, model: "haiku-5.5", effort: "medium", speed: "slow" };
  config.COMPACTORS.splice(0, config.COMPACTORS.length, primary, fallback);
  failModel = "claude-opus-5-5";
  const mem = Memory.load(dir, () => SHARE);
  try {
    Memory.push(mem, [{ kind: "unii" as const, text: "message " + "word ".repeat(160) }]);
    await complete(mem, 1);
    expect(calls["claude-opus-5-5"]).toBe(1);
    expect(calls["claude-haiku-5-5"]).toBeGreaterThan(0);
    expect(Memory.node(mem, { l: 0, i: 0 })).toBe(line("leaf 0"));
  } finally {
    config.COMPACTORS.splice(0, config.COMPACTORS.length, ...original);
    Memory.stop(mem);
  }
});
