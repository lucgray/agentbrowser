import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_NAMES } from '../../server/hub/tools.mjs';

test('every tool schema carries the optional label arg (v2.2)', () => {
  for (const t of TOOLS) {
    assert.ok(t.args && t.args.properties, `${t.name} has args.properties`);
    assert.equal(t.args.properties.label.type, 'string', `${t.name} has label`);
  }
});

test('composite wrappers exist (v2.2)', () => {
  for (const name of ['fill', 'wait_for', 'read_elements', 'batch']) {
    assert.ok(TOOL_NAMES.includes(name), `${name} in TOOLS`);
  }
});

test('batch declares steps and stopOnError', () => {
  const batch = TOOLS.find((t) => t.name === 'batch');
  assert.ok(batch.args.required.includes('steps'));
  assert.equal(batch.args.properties.steps.type, 'array');
  assert.equal(batch.args.properties.steps.items.required.includes('tool'), true);
});

test('fill requires selector+text; wait_for takes selector or text', () => {
  const fill = TOOLS.find((t) => t.name === 'fill');
  assert.deepEqual(fill.args.required.sort(), ['selector', 'text']);
  const waitFor = TOOLS.find((t) => t.name === 'wait_for');
  assert.ok(waitFor.args.properties.selector && waitFor.args.properties.text);
});
