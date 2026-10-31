import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unii-provider-test-"));
const envKeys = ["UNII_DIR", "UNII_LOCAL", "UNII_T3", "UNII_SITE"];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.UNII_DIR = dir;
process.env.UNII_LOCAL = "1";
process.env.UNII_T3 = "1";
process.env.UNII_SITE = "http://127.0.0.1:8788";
const { LocalAgent, completion, reply } = await import("./LocalAgent.ts");
const { Pick } = await import("./Pick.ts");
const { Acp } = await import("./LocalProcess.ts");

const fake = path.join(dir, "provider.ts");
fs.writeFileSync(fake, `const prompt = await Bun.stdin.text();
if (prompt.includes("WAIT_FOR_CANCEL")) await Bun.sleep(60000);
const text = prompt.includes("Tool result:") ? JSON.stringify({text:"tool result received",tool:null}) : prompt.includes("UNIICHAT RESPONSE PROTOCOL") ? JSON.stringify({text:"",tool:{name:"echo",input:{text:"hello"}}}) : "summary";
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));`);
fs.writeFileSync(path.join(dir, "t3-runtimes.json"), JSON.stringify({ fake: { command: [process.execPath, fake], transport: "codex" } }));
const ask = { vendor: "t3-fake" as const, model: "fake", effort: "medium", speed: "slow", system: "test", blocks: [{text:"hello",mark:false}], searches: 0, server: "" };
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("local tools run through Unii and their results return to the provider", async () => {
  const calls: any[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const rpc = await req.json() as any;
    const result = rpc.method === "tools/list" ? { tools: [{name:"echo",description:"test",inputSchema:{type:"object"}}] } : {content:[{type:"text",text:rpc.params.arguments.text}]};
    if (rpc.method === "tools/call") calls.push(rpc.params);
    return Response.json({jsonrpc:"2.0",id:rpc.id,result});
  } });
  try {
    const events: any[] = [];
    const call = LocalAgent.ask({...ask,server:server.url.href}, (event) => events.push(event));
    expect((await call.done).ok).toBe(true);
    expect(calls).toEqual([{name:"echo",arguments:{text:"hello"}}]);
    expect(events.filter((e) => e.$ === "Entry").map((e) => e.kind)).toEqual(["tool","echo","unii"]);
    expect(events.at(-1).text).toBe("tool result received");
  } finally { server.stop(true); }
});

test("stopping a local completion ends its child process promptly", async () => {
  const call = LocalAgent.ask({...ask, blocks:[{text:"WAIT_FOR_CANCEL",mark:false}]}, () => {});
  await Bun.sleep(100);
  call.stop();
  const end = await Promise.race([call.done, Bun.sleep(3000).then(() => {throw new Error("stop hung");})]);
  expect(end.ok).toBe(false);
  expect(end.stop).toBe("lost");
});

test("summary completions return their text to the memory builder", async () => {
  const call = LocalAgent.ask(ask, () => {});
  const end = await call.done;
  expect(end.ok).toBe(true);
  expect(end.text).toBe("summary");
});

test("messages sent during a completion are acknowledged and consumed", async () => {
  const events: any[] = [];
  const call = LocalAgent.ask(ask, (event) => events.push(event));
  call.send({text:"one more",imgs:[]});
  const end=await call.done;
  expect(end.ok).toBe(true);
  expect(end.left).toEqual([]);
  expect(events.some((e)=>e.$==="Entry"&&e.kind==="user"&&e.text==="one more")).toBe(true);
});

test("unknown tools and prose cannot be interpreted as executable tool requests", () => {
  expect(reply('Here is an example: {"text":"", "tool":{"name":"shell","input":{}}}').tool).toBeUndefined();
  expect(() => reply('{"text":"", "tool":{"name":"shell","input":"bad"}}')).toThrow();
  expect(completion('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',"codex")).toBe("ok");
  expect(() => completion('{"type":"turn.failed"}',"codex")).toThrow();
});

test("model selections distinguish providers and preserve model ids containing colons", () => {
  const offer = { vendors:["t3-codex", "t3-hermes"] as const, models:["gpt-6.1-sol", "openai-codex:gpt-6-luna"] };
  const from = {vendor:"t3-codex" as const,model:"gpt-6.1-sol",effort:"medium",speed:"slow"};
  const next = {vendor:"t3-hermes" as const,model:"openai-codex:gpt-6-luna",effort:"medium",speed:"slow"};
  expect(Pick.move(from,"model",{...offer,vendors:[...offer.vendors]},Pick.label(next))).toEqual(next);
  expect(Pick.read({...from,effort:"made-up"},{...offer,vendors:[...offer.vendors]})).toBeNull();
});

test("ACP model selection, streamed text, and denied permissions", async () => {
  const file = path.join(dir,"acp.ts");
  fs.writeFileSync(file, `import {createInterface} from "node:readline";
const send=(msg)=>console.log(JSON.stringify({jsonrpc:"2.0",...msg}));
createInterface({input:process.stdin}).on("line",(line)=>{
 const msg=JSON.parse(line);
 if(msg.method==="initialize") send({id:msg.id,result:{protocolVersion:2}});
 if(msg.method==="session/new") send({id:msg.id,result:{sessionId:"one",configOptions:[{configId:"model",options:[{value:"test"}]}]}});
 if(msg.method==="session/set_config_option") send({id:msg.id,result:{}});
 if(msg.method==="session/prompt") {send({id:999,method:"session/request_permission",params:{}}); globalThis.waitId=msg.id;}
 if(msg.id===999&&msg.result?.outcome?.outcome==="cancelled") {send({method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"ok"}}}});send({id:globalThis.waitId,result:{stopReason:"end_turn"}});}
});`);
  const acp = new Acp({command:[process.execPath,file],transport:"acp"},dir,AbortSignal.timeout(4000));
  try {
    const session = await acp.start(dir);
    await acp.pick(session,"test","medium");
    expect(await acp.prompt(session.sessionId,"hello")).toBe("ok");
  } finally { acp.close(); }
});
