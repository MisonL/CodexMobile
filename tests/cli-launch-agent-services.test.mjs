import assert from 'node:assert/strict';
import test from 'node:test';

import { execFilePromise } from '../cli/launch-agent-services.mjs';

test('execFilePromise retries transient launchctl kickstart errors', async () => {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, timeout: options.timeout });
    if (calls.length === 1) {
      callback(Object.assign(new Error('transient'), { code: 37 }), '', '');
      return;
    }
    callback(null, 'ok\n', '');
  };

  const result = await execFilePromise(
    execFile,
    'launchctl',
    ['kickstart', '-k', 'gui/501/com.codexmobile.agent'],
    { retries: 2, delayMs: 0 }
  );

  assert.equal(result.stdout, 'ok\n');
  assert.equal(calls.length, 2);
});

test('execFilePromise does not retry unrelated command failures', async () => {
  let calls = 0;
  const execFile = (_command, _args, _options, callback) => {
    calls += 1;
    callback(Object.assign(new Error('permission denied'), { code: 5 }), '', 'permission denied');
  };

  await assert.rejects(
    execFilePromise(execFile, 'launchctl', ['bootstrap'], { retries: 2, delayMs: 0 }),
    /permission denied/
  );
  assert.equal(calls, 1);
});
