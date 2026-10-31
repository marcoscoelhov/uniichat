// Memory lost-provider test
// =========================
// `bun test MemoryLost.test.ts`. A local compactor that isn't there (the
// provider was removed, its process ended) throws at once. The node must
// wait for a later try, not start again in the same tick: an immediate
// retry would throw again, starve every timer and flood the log.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-lost-");
process.env.UNII_DIR = DIR;
process.env.UNII_LOCAL = "1";
process.env.UNII_T3 = "1";
process.env.UNII_COMPACTOR = "t3-opencode:opencode/mimo-v2.6-flash-free:medium:slow";

const config = await import("./Config.ts");
const { Memory } = await import("./Memory.ts");
const { Pick } = await import("./Pick.ts");
const { MASTER } = await import("./Tools.ts");
import type { Memory as Mem } from "./Memory.ts";

const SHARE = { ...Pick.ask(config.PICK), system: MASTER, searches: 0, server: "" };

test("a missing local compactor waits for its next try, not a hot loop", async () => {
  // the catalog knows opencode, but its command path is gone; one
  // compactor isolates the retry behavior from the fallback chain
  fs.writeFileSync(DIR + "/t3-runtimes.json", "{}\n");
  const original = [...config.COMPACTORS];
  config.COMPACTORS.splice(0, config.COMPACTORS.length, { vendor: "t3-opencode", model: "opencode/mimo-v2.6-flash-free", effort: "medium", speed: "slow" });
  const mem: Mem = Memory.load(DIR + "/chat", () => SHARE);
  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    Memory.push(mem, [{ kind: "unii", text: "message " + "word ".repeat(160) }]);
    await new Promise((ok) => setTimeout(ok, 200));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Local provider missing");
    expect(mem.busy.size).toBe(0);
    expect(mem.retries.size).toBe(1);
  } finally {
    Memory.stop(mem);
    config.COMPACTORS.splice(0, config.COMPACTORS.length, ...original);
    console.error = real;
  }
  expect(mem.retries.size).toBe(0);
});
