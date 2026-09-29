import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelFromAgentbrowser } from '../../server/adapters/cli-label.mjs';

test('labelFromAgentbrowser lifts the call label out of a CLI command', () => {
  assert.equal(
    labelFromAgentbrowser(`agentbrowser eval_js '{"expression":"1+1","label":"计算价格总数"}'`),
    '计算价格总数'
  );
  assert.equal(
    labelFromAgentbrowser(`agentbrowser click '{"x":1,"y":2,"label":"点确定"}'`),
    '点确定'
  );
});

test('labelFromAgentbrowser falls back when there is nothing to lift', () => {
  assert.equal(labelFromAgentbrowser(`agentbrowser click '{"x":1}'`), undefined);
  assert.equal(labelFromAgentbrowser('ls -la /tmp'), undefined);
  assert.equal(labelFromAgentbrowser(undefined), undefined);
  assert.equal(labelFromAgentbrowser(`echo '{"label":"x"}'`), undefined);
});

test('labelFromAgentbrowser handles node-style invocation and caps length', () => {
  assert.equal(
    labelFromAgentbrowser(`node server/proxy/agentbrowser-cli.mjs click '{"label":"ok"}'`),
    'ok'
  );
  const long = 'x'.repeat(120);
  assert.equal(labelFromAgentbrowser(`agentbrowser click '{"label":"${long}"}'`).length, 80);
});
