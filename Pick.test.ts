// Pick test
// =========
// `bun test Pick.test.ts`. The default offer keeps every label whole: a
// local provider names a model by a JSON pair, commas and all, so it must
// not be joined and split on the way in. A pick saved on one of those
// models is read back, and the DSH group lists every provider it serves.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-pick-");
process.env.UNII_DIR = DIR;
process.env.UNII_LOCAL = "1";
process.env.UNII_T3 = "1";
delete process.env.UNII_MODELS;
delete process.env.UNII_COMPACTORS;

const { LABELS, Pick, T3_PROVIDERS } = await import("./Pick.ts");
const { OFFER, COMPACTOR, COMPACTORS } = await import("./Config.ts");

const DSH = '["opengateway","deepseek/deepseek-v4.1-flash-ultrafast"]';

test("the default offer keeps labels that hold commas", () => {
  expect(OFFER.models).toEqual(LABELS);
  expect(OFFER.models).toContain(DSH);
  expect(OFFER.models.some((label) => label.endsWith("-ultrafast\"]"))).toBe(true);
});

test("dsh lists every model of every provider it serves", () => {
  const dsh = T3_PROVIDERS.find((provider) => provider.id === "dsh")!;
  expect(Pick.models(["t3-dsh"], OFFER.models)).toHaveLength(dsh.models.length);
  expect(dsh.models.map((model) => model.label)).toContain("Open Gateway · DeepSeek V4.1 Flash Ultrafast");
  expect(dsh.models.some((model) => model.label.startsWith("Open Design · "))).toBe(true);
  expect(dsh.models.some((model) => model.label.startsWith("DeepSeek oficial · "))).toBe(true);
  expect(dsh.models.every((model) => model.efforts?.join(",") === "off,high,max")).toBe(true);
  expect(dsh.models.length).toBeGreaterThan(1);
});

test("a saved pick on a JSON-pair model is read back", () => {
  const pick = { vendor: "t3-dsh" as const, model: DSH, effort: "high", speed: "slow" };
  expect(Pick.read(pick, OFFER)).toEqual(pick);
  expect(Pick.model("t3-dsh", DSH)?.id).toBe(DSH);
  expect(Pick.model("t3-dsh", DSH)?.name).toBe("Open Gateway · DeepSeek V4.1 Flash Ultrafast");
});

test("the compactor chain starts at the primary and falls back to fast, cheap models", () => {
  const labels = COMPACTORS.map(Pick.label);
  expect(COMPACTORS[0]).toEqual(COMPACTOR);
  expect(labels[0]).toBe(Pick.label(COMPACTOR));
  expect(labels).toContain("t3-opencode:opencode/mimo-v2.6-flash-free:medium:slow");
  expect(labels).toContain('t3-dsh:["opendesign","deepseek-v4.1-flash"]:high:slow');
  expect(labels).toContain('t3-dsh:["deepseek-official","deepseek-flash"]:high:slow');
  expect(labels.length).toBeGreaterThan(1);
});
