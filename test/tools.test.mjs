import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectTools, toolById, toolReport } from '../src/tools.mjs';
import { findBinary, windowsInvocation } from '../src/toolrun.mjs';

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

test('a Windows batch shim is run through the interpreter that can run it', () => {
  // npm installs rtk and ccusage as rtk.cmd, and a batch file is not a program:
  // execFile refuses one outright and finds nothing by bare name, since only the
  // shell applies PATHEXT. Both tool panels were dead on Windows because of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-win-'));
  try {
    fs.writeFileSync(path.join(dir, 'rtk.cmd'), '@echo off\r\n');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' };

    const found = findBinary('rtk', env, 'win32');
    assert.equal(found.found, true);
    assert.ok(found.path.endsWith('rtk.cmd'));

    const invocation = windowsInvocation('rtk', ['gain', '--format', 'json'], env);
    assert.equal(invocation.file, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(invocation.args[3], /^"[^"]*rtk\.cmd" "gain" "--format" "json"$/);
    assert.equal(invocation.options.windowsVerbatimArguments, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real executable is run directly, with no interpreter in between', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admin-win-'));
  try {
    fs.writeFileSync(path.join(dir, 'rtk.exe'), '');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const invocation = windowsInvocation('rtk', ['--version'], env);
    assert.ok(invocation.file.endsWith('rtk.exe'));
    assert.deepEqual(invocation.args, ['--version']);
    assert.deepEqual(invocation.options, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
