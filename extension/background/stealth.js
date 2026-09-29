// Preload script presets for `inject_preload` — page-side sources evaluated at
// document start via Page.addScriptToEvaluateOnNewDocument, before any page JS.
//
// `antidetect` neutralises disable-devtool-style probes (the family Boss-style
// sites run): console.* timing tables and performance.now hooks die quietly,
// while Function.prototype.toString reports every replaced function —
// toString itself included — as native code. Deliberately catches nothing
// loudly: inside a hostile page a thrown or logged probe is itself a tell.
export const ANTIDETECT_SCRIPT = `(function () {
  'use strict';
  var navStart = (typeof performance !== 'undefined' && performance.timing && performance.timing.navigationStart) || Date.now();
  var nativeToString = Function.prototype.toString;
  var spoofed = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var noop = function () {};
  function replace(obj, name, impl, src) {
    try {
      if (!obj || typeof obj[name] !== 'function') return;
      var wrapper = function () { return impl.apply(this, arguments); };
      if (spoofed) spoofed.set(wrapper, src || ('function ' + name + '() { [native code] }'));
      obj[name] = wrapper;
    } catch (e) {}
  }
  try {
    Function.prototype.toString = function () {
      if (this === Function.prototype.toString) return 'function toString() { [native code] }';
      var fake = spoofed && spoofed.get(this);
      if (fake) return fake;
      return nativeToString.apply(this, arguments);
    };
    if (spoofed) spoofed.set(Function.prototype.toString, 'function toString() { [native code] }');
  } catch (e) {}
  ['table', 'clear', 'log', 'dir', 'debug', 'info', 'trace',
    'time', 'timeEnd', 'timeLog', 'group', 'groupCollapsed', 'groupEnd',
    'count', 'countReset'].forEach(function (m) {
    replace(console, m, noop);
  });
  // Strictly increasing — a frozen or repeated clock is the easiest hook to
  // spot (t1 === t2), so same-ms reads still nudge forward like real timing.
  var lastNow = 0;
  replace(performance, 'now', function () {
    var v = Date.now() - navStart;
    if (v <= lastNow) v = lastNow + 0.001 + Math.random() * 0.001;
    lastNow = v;
    return v;
  });
  try {
    if (navigator.webdriver) {
      Object.defineProperty(navigator, 'webdriver', {
        get: function () { return false; },
        configurable: true,
      });
    }
  } catch (e) {}
})();`;

export const PRELOAD_PRESETS = {
  antidetect: ANTIDETECT_SCRIPT,
};
