import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITE_TOOLS,
  domainMatches,
  needsConsent,
  rememberSessionAllow,
  resetSessionAllows,
  requiredTools,
  shouldCheck,
  summarizeArgs,
} from './consent-core.js';

const POLICY = { requireConsent: ['click', 'navigate'] };

test('absent or non-object policy disables the gate', () => {
  assert.equal(needsConsent('click', 'https://a.com/', null), false);
  assert.equal(needsConsent('click', 'https://a.com/', undefined), false);
  assert.equal(needsConsent('click', 'https://a.com/', 'x'), false);
});

test('only listed tools gate; reads never do', () => {
  assert.equal(needsConsent('click', 'https://a.com/', POLICY), true);
  assert.equal(needsConsent('read_page', 'https://a.com/', POLICY), false);
  assert.equal(needsConsent('screenshot', 'https://a.com/', {}), false);
});

test('requireConsent defaults to WRITE_TOOLS when policy exists', () => {
  assert.deepEqual(requiredTools({}), WRITE_TOOLS);
  assert.deepEqual(requiredTools({ requireConsent: ['navigate'] }), ['navigate']);
  assert.equal(needsConsent('eval_js', 'https://a.com/', {}), true);
});

test('allowAll:true disables the gate entirely, even on sensitive domains', () => {
  const p = { allowAll: true, requireConsent: ['click'], sensitiveDomains: ['bank.com'] };
  assert.equal(shouldCheck('click', p), false);
  assert.equal(needsConsent('click', 'https://bank.com/x', p), false);
  assert.equal(needsConsent('eval_js', 'https://a.com/', p), false);
});

test('shouldCheck pre-filters absent policies, allowAll, and non-listed tools', () => {
  assert.equal(shouldCheck('click', null), false);
  assert.equal(shouldCheck('click', 'x'), false);
  assert.equal(shouldCheck('read_page', { requireConsent: ['click'] }), false);
  assert.equal(shouldCheck('click', { requireConsent: ['click'] }), true);
  assert.equal(shouldCheck('click', {}), true); // default write set
});

test('hostless URLs never gate; chrome:// gates via notification fallback', () => {
  // chrome://extensions parses with hostname "extensions" — gated calls ask
  // through the system-notification path since content scripts can't inject.
  assert.equal(needsConsent('click', 'chrome://extensions', POLICY), true);
  assert.equal(needsConsent('click', 'about:blank', POLICY), false);
  assert.equal(needsConsent('click', '', POLICY), false);
  assert.equal(needsConsent('click', 'file:///tmp/x.html', POLICY), false);
});

test('domainMatches: exact or dot-boundary suffix', () => {
  assert.equal(domainMatches('a.com', ['a.com']), true);
  assert.equal(domainMatches('app.a.com', ['a.com']), true);
  assert.equal(domainMatches('nota.com', ['a.com']), false);
  assert.equal(domainMatches('a.com.evil.org', ['a.com']), false);
  assert.equal(domainMatches('', ['a.com']), false);
  assert.equal(domainMatches('a.com', null), false);
});

test('trustedDomains bypass, sensitiveDomains always ask', () => {
  const p = { ...POLICY, trustedDomains: ['local.dev'], sensitiveDomains: ['bank.com'] };
  assert.equal(needsConsent('click', 'https://local.dev/x', p), false);
  assert.equal(needsConsent('click', 'https://bank.com/x', p), true);
  assert.equal(needsConsent('read_page', 'https://bank.com/x', p), false); // not gated
});

test('sensitiveDomains win over trustedDomains on overlap', () => {
  const p = { ...POLICY, trustedDomains: ['bank.com'], sensitiveDomains: ['bank.com'] };
  assert.equal(needsConsent('click', 'https://bank.com/x', p), true);
});

test('session allow skips repeat prompts; sensitive domain ignores it', () => {
  resetSessionAllows();
  const p = { ...POLICY, sensitiveDomains: ['bank.com'] };
  rememberSessionAllow('https://a.com', 'click');
  assert.equal(needsConsent('click', 'https://a.com/x', p), false);
  // per-tool: a click grant does not cover navigate
  assert.equal(needsConsent('navigate', 'https://a.com/x', p), true);
  // per-origin
  assert.equal(needsConsent('click', 'https://b.com/x', p), true);
  rememberSessionAllow('https://bank.com', 'click');
  assert.equal(needsConsent('click', 'https://bank.com/x', p), true);
});

test('summarizeArgs renders each gated tool', () => {
  assert.equal(summarizeArgs('click', { x: 10.4, y: 5.6 }), 'click at (10, 6)');
  assert.equal(summarizeArgs('click_element', { selector: 'button.buy' }), "click 'button.buy'");
  assert.equal(summarizeArgs('navigate', { url: 'https://x.dev' }), 'navigate → https://x.dev');
  assert.equal(summarizeArgs('eval_js', { expression: 'abc' }), 'run JavaScript (3 chars)');
  assert.equal(summarizeArgs('patch_apply', { patches: [{}, {}] }), 'live-patch 2 node(s)');
  assert.equal(summarizeArgs('annotate_clear', {}), 'remove all annotations');
});
