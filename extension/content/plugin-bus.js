// Plugin bus (v2.24): the content-side plugin contract. Core module — runs on
// every page before the other content scripts and exposes one global,
// `window.__abPlugins`, with three things:
//
//   provide(ns, api)      a plugin exposes a named service other plugins call
//   call(ns, fn, ...args) cross-plugin calls (sync; the bus passes through)
//   registerToolbarAction({plugin, id, icon, label, run, kind})
//                         a plugin adds a slot on the selection toolbar —
//                         kind 'button' (default), 'palette' (swatch row)
//                         or 'input' (inline text field; Enter → run(text, ctx))
//   registerPageTool(name, fn)
//                         a plugin exposes a function agents invoke as a
//                         tool: the hub declares it via plugin.json
//                         extraTools; the call lands here through the sw
//                         plugin_op route and fn(args) returns the result
//   callPageTool(name, args)
//                         the page-side dispatch behind {target:'plugins'}
//   toolbarActions()      current slots; selection.js renders them each open
//   toolbarEnabled(id)    per-action config gate — pluginToolbar map in
//                         chrome.storage.local; default ON. ASK itself is a
//                         registered action, so nothing on the bar is
//                         mandatory: the bar only shows what is enabled.
//
// The bus itself never touches the DOM and never gates on plugins being
// enabled — a disabled plugin simply never registers, so its slots and
// services don't exist.

(function () {
  if (window.__abPlugins) return; // all_frames + retries: single-run
  const TAG = "[agentbrowser]";
  const services = new Map(); // ns -> api
  const pageTools = new Map(); // tool name -> fn(args)
  const actions = []; // {plugin, id, icon, label, run, kind, colors, get, set}
  let toolbarCfg = null; // pluginToolbar map (null = not loaded yet → all on)

  function toolbarEnabled(id) {
    return !toolbarCfg || toolbarCfg[id] !== false;
  }

  function logWarn(...a) {
    console.warn(TAG, ...a);
  }

  window.__abPlugins = {
    provide(ns, api) {
      services.set(String(ns), api || {});
    },
    has(ns) {
      return services.has(String(ns));
    },
    call(ns, fn, ...args) {
      const s = services.get(String(ns));
      if (!s || typeof s[fn] !== "function") {
        logWarn(`plugin call ${ns}.${fn}: no provider`);
        return null;
      }
      try {
        return s[fn](...args);
      } catch (err) {
        logWarn(`plugin call ${ns}.${fn} failed`, err);
        return null;
      }
    },
    registerPageTool(name, fn) {
      if (!name || typeof fn !== "function") return;
      pageTools.set(String(name), fn);
    },
    callPageTool(name, args) {
      const fn = pageTools.get(String(name));
      if (!fn) return { ok: false, error: "no page tool: " + name };
      try {
        return Promise.resolve(fn(args || {})).then(
          (result) => ({ ok: true, result: result === undefined ? {} : result }),
          (err) => {
            logWarn(`page tool ${name} failed`, err);
            return { ok: false, error: String((err && err.message) || err) };
          }
        );
      } catch (err) {
        logWarn(`page tool ${name} threw`, err);
        return Promise.resolve({ ok: false, error: String((err && err.message) || err) });
      }
    },
    registerToolbarAction(a) {
      if (!a || !a.id || typeof a.run !== "function") return;
      actions.push(a);
    },
    // Replace a plugin's whole action set (e.g. on enable/disable flip).
    setToolbarActions(plugin, list) {
      for (let i = actions.length - 1; i >= 0; i--) {
        if (actions[i].plugin === plugin) actions.splice(i, 1);
      }
      for (const a of list || []) {
        if (a && a.id && typeof a.run === "function") actions.push(a);
      }
    },
    toolbarActions() {
      return actions.slice();
    },
    toolbarEnabled,
    // Config store: {actionId: false} hides that slot. Read once, then kept
    // live via storage.onChanged (the context-menu checkboxes write the map).
    async loadToolbarConfig() {
      try {
        const r = await chrome.storage.local.get({ pluginToolbar: {} });
        toolbarCfg = r.pluginToolbar || {};
      } catch (err) {
        logWarn("pluginToolbar read failed", err);
        toolbarCfg = {};
      }
      return toolbarCfg;
    },
  };

  try {
    chrome.storage.onChanged.addListener((chg, area) => {
      if (area === "local" && chg.pluginToolbar) {
        toolbarCfg = chg.pluginToolbar.newValue || {};
      }
    });
    window.__abPlugins.loadToolbarConfig();
  } catch (err) {
    logWarn("pluginToolbar listener failed", err);
  }

  // plugin_op route (v2.25): the service worker relays agent tool calls that
  // no built-in tool owns; the matching registerPageTool handler answers.
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.target !== "plugins" || message.cmd !== "op") return;
      // all_frames injects the bus everywhere; without frameId every frame
      // would run the op and the first sendResponse wins — only the top
      // frame may answer page tools.
      if (window.top !== window) return;
      Promise.resolve(window.__abPlugins.callPageTool(message.tool, message.args)).then(sendResponse);
      return true; // callPageTool resolves async
    });
  } catch (err) {
    logWarn("plugin_op listener failed", err);
  }
})();
