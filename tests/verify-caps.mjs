// One-shot harness: connect, ask for capabilities, print the adapter rows.
const ws = new WebSocket("ws://127.0.0.1:9010");
const id = "v1";
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "hello", role: "harness", name: "cap-verify" }));
  ws.send(JSON.stringify({ type: "get_capabilities" }));
};
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === "capabilities") {
    for (const a of m.adapters || []) {
      const st = a.status || "ready";
      const tr = a.transport ? ` [${a.transport}]` : "";
      const variants = a.variants ? ` (variants: ${a.variants.map(v => v.name + "=" + v.status).join(", ")})` : "";
      console.log(`${a.name} | ${a.label}${tr} | ${st}${a.detail ? " | " + a.detail : ""}${variants}`);
    }
    console.log("TOTAL ROWS:", (m.adapters || []).length);
    ws.close();
    process.exit(0);
  }
};
setTimeout(() => { console.error("timeout waiting capabilities"); process.exit(1); }, 8000);
