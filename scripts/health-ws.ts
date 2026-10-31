// Health check: the local app answers its root with the local session
// cookie, and a WebSocket sends the chat state. Used by the VPS deploy
// after a restart, and with --idle before touching a running chat.

const base = (process.env.UNII_HEALTH_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const idle = process.argv.includes("--idle");

const res = await fetch(base + "/", { redirect: "manual" }).catch(() => null);
if (res === null || res.status !== 302) {
  console.error("health: root " + (res?.status ?? "unreachable"));
  process.exit(1);
}
const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws?tab=health&wire=2", { headers: { cookie } } as any);

const state = await new Promise<any>((resolve) => {
  const timer = setTimeout(() => resolve(null), 10000);
  ws.onmessage = (event) => {
    if (String(event.data) === "+") {
      return;
    }
    try {
      const msg = JSON.parse(String(event.data));
      if (msg.$ === "state" || msg.$ === "error") {
        clearTimeout(timer);
        resolve(msg);
      }
    } catch {}
  };
  ws.onerror = () => {
    clearTimeout(timer);
    resolve(null);
  };
});
ws.close();

if (state === null || state.$ !== "state") {
  console.error("health: no state" + (state?.text ? ": " + state.text : ""));
  process.exit(1);
}
console.log(JSON.stringify({ busy: state.busy, wait: state.wait, models: state.models?.length, vendors: state.vendors?.length }));
if (idle && state.busy) {
  console.error("health: chat is busy");
  process.exit(2);
}
process.exit(0);
