// One-shot: connect, capabilities, print each adapter's real model list.
const ws = new WebSocket("ws://127.0.0.1:9010");
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "hello", role: "harness", name: "model-verify" }));
  ws.send(JSON.stringify({ type: "get_capabilities" }));
};
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === "capabilities") {
    for (const a of m.adapters || []) {
      const models = Array.isArray(a.models) ? a.models : [];
      const ids = models.map((x) => x.id).filter(Boolean);
      const preview = ids.slice(0, 6).join(", ");
      console.log(`${a.name} [${a.transport || "-"}] models=${ids.length}${preview ? " :: " + preview + (ids.length > 6 ? " …" : "") : ""}`);
    }
    ws.close();
    process.exit(0);
  }
};
setTimeout(() => { console.error("timeout"); process.exit(1); }, 8000);
