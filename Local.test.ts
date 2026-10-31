import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";

const dir = fs.mkdtempSync("/tmp/unii-local-test-");
process.env.UNII_DIR = dir;
process.env.UNII_SITE = "http://127.0.0.1:8788";
process.env.UNII_LOCAL = "1";
const { Cloud } = await import("./Cloud.ts");
const cloud = Cloud.open(() => {}, () => {}, async () => null);
afterAll(() => {
  cloud.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("local entry creates a normal session and reuses the same chat", async () => {
  const enter = () => Cloud.local(cloud, new Request("http://127.0.0.1:8788/"))!;
  const first = enter();
  expect(first.status).toBe(302);
  const request = (res: Response) => new Request("http://127.0.0.1:8788/api/me", {
    headers: { cookie: res.headers.get("set-cookie")!.split(";")[0] },
  });
  const user = Cloud.who(cloud, request(first));
  expect(user?.name).toBe("local@localhost");
  expect(Cloud.who(cloud, request(enter()))?.id).toBe(user!.id);
  expect(Cloud.who(cloud, new Request("http://127.0.0.1:8788/api/me"))).toBeNull();
  const me = await Cloud.http(cloud, request(first));
  expect(await me!.json()).toMatchObject({ id: user!.id, local: true });
});

test("local entry refuses other origins and billed servers", () => {
  expect(Cloud.local(cloud, new Request("https://example.com/"))).toBeNull();
  cloud.billing.bills = true;
  expect(Cloud.local(cloud, new Request("http://127.0.0.1:8788/"))).toBeNull();
  cloud.billing.bills = false;
});
