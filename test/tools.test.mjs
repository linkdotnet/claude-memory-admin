import assert from 'node:assert/strict';
import test from 'node:test';

import { detectTools, toolById, toolReport } from '../src/tools.mjs';

test('every registered tool declares what the tab strip needs to show it', () => {
  const tools = detectTools({ PATH: '' });
  assert.ok(tools.length >= 2);
  for (const tool of tools) {
    assert.equal(typeof tool.id, 'string');
    assert.equal(typeof tool.label, 'string');
    assert.equal(typeof tool.blurb, 'string');
    assert.match(tool.repo, /^https:\/\//);
    assert.equal(tool.found, false);
    assert.equal(tool.path, null);
  }
  assert.deepEqual(tools.map((tool) => tool.id), ['rtk', 'ccusage']);
});

test('the registry never exposes the binary name it will execute', () => {
  for (const tool of detectTools({ PATH: '' })) {
    assert.equal('binary' in tool, false);
  }
});

test('a tool id that is not registered is refused before anything is spawned', async () => {
  assert.equal(toolById('rtk; rm -rf /'), null);
  await assert.rejects(() => toolReport('rtk; rm -rf /', {}), /Unknown tool/);
  await assert.rejects(() => toolReport('../../bin/sh', {}), /Unknown tool/);
});

test('a registered tool that is not installed is refused before it is run', async () => {
  await assert.rejects(() => toolReport('ccusage', {}, { env: { PATH: '' } }), /ccusage is not installed/);
});
