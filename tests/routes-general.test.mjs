import assert from 'node:assert/strict';
import test from 'node:test';

import { createGeneralRouteHandler } from '../server/routes-general.js';

function createResponseRecorder() {
  return {
    body: '',
    headers: null,
    status: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    }
  };
}

test('projects route returns cached projects without refreshing', async () => {
  let refreshCalled = false;
  const handler = createGeneralRouteHandler({
    list: () => [{ id: 'project-1', name: 'Project 1' }],
    refreshProjects: async () => {
      refreshCalled = true;
      return { projects: [] };
    }
  });
  const res = createResponseRecorder();

  const handled = await handler({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res, {
    method: 'GET',
    pathname: '/api/projects'
  });

  assert.equal(handled, true);
  assert.equal(refreshCalled, false);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { projects: [{ id: 'project-1', name: 'Project 1' }] });
});

test('projects route reports refresh failure instead of throwing', async () => {
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  const handler = createGeneralRouteHandler({
    list: () => [],
    refreshProjects: async () => {
      throw new Error('config unreadable');
    }
  });
  const res = createResponseRecorder();

  try {
    const handled = await handler({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res, {
      method: 'GET',
      pathname: '/api/projects'
    });

    assert.equal(handled, true);
    assert.equal(res.status, 500);
    assert.deepEqual(res.json(), { error: 'Failed to refresh project cache' });
    assert.match(warnings[0], /projects.*config unreadable/);
  } finally {
    console.warn = previousWarn;
  }
});
