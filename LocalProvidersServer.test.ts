import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("local server offers the T3 catalog and persists provider/model choices across connections", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unii-t3-server-"));
  const site = "http://127.0.0.1:9495";
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir,"Server.ts"), "9495"], {
    env: { ...process.env, UNII_DIR: dir, UNII_SITE: site, UNII_LOCAL: "1", UNII_T3: "1" }, stdout: "ignore", stderr: "inherit",
  });
  const sockets: WebSocket[] = [];
  try {
    let root: Response | null = null;
    for (let n=0;n<100;n++) {
      root = await fetch(site,{redirect:"manual"}).catch(()=>null);
      if (root) break;
      await Bun.sleep(50);
    }
    expect(root?.status).toBe(302);
    const cookie = root!.headers.get("set-cookie")!.split(";")[0];
    const html = await (await fetch(site,{headers:{cookie}})).text();
    expect(html).toContain('aria-label="Provedores e modelos"');
    expect((await fetch(site+"/api/me",{headers:{cookie}})).status).toBe(200);
    const connect = () => new Promise<{ws:WebSocket;state:any}>((resolve,reject)=>{
      const ws = new WebSocket(site.replace("http","ws")+"/ws?wire=2&tab=test-"+crypto.randomUUID(), {headers:{cookie}});
      sockets.push(ws);
      const timer=setTimeout(()=>reject(new Error("no state")),4000);
      ws.addEventListener("message",event=>{const msg=JSON.parse(String(event.data));if(msg.$==="state"){clearTimeout(timer);resolve({ws,state:msg});}}, {once:false});
      ws.addEventListener("error",()=>reject(new Error("socket failed")));
    });
    const {ws,state} = await connect();
    expect(state.vendors).toEqual(expect.arrayContaining(["t3-codex","t3-claudeAgent","t3-grok","t3-opencode","t3-antigravity","t3-pi","t3-hermes","t3-dsh"]));
    expect(state.pick.vendor).toBe("t3-codex");
    const to={vendor:"t3-hermes",model:"openai-codex:gpt-6-luna",effort:"medium",speed:"slow"};
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("pick not acknowledged")),4000);
      ws.addEventListener("message",event=>{const msg=JSON.parse(String(event.data));if(msg.$==="ack"&&msg.id==="pick-test"){clearTimeout(timer);msg.error?reject(new Error(msg.error)):resolve();}});
      ws.send(JSON.stringify({$:"pick",id:"pick-test",to}));
    });
    ws.close();
    const reopened=await connect();
    expect(reopened.state.pick).toEqual(to);
  } finally {
    for(const ws of sockets) ws.close();
    proc.kill();
    await proc.exited;
    fs.rmSync(dir,{recursive:true,force:true});
  }
},10000);
