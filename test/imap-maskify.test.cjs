const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { BatchRunner } = require('../batch.cjs');
const { createApp } = require('../server.cjs');

const accounts = () => Array.from({ length: 4 }, (_, index) => ({ email: `test${index}@gmx.de`, password: 'test-password' }));
const maskifyEnv = { MASKIFY_USERNAME: 'test-maskify-user', MASKIFY_PASSWORD: 'test-maskify-password' };

async function runnerFor(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gmx-imap-maskify-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new BatchRunner({ root, maskifyEnv, apiKey: 'test-api-key',
    automate: async input => ({ enabled: true, screenshotPath: input.screenshotPath }), ...options });
}

test('IMAP Maskify mode creates a separate session per account and preserves requested concurrency', async t => {
  const urls = [];
  let active = 0, maxActive = 0;
  const runner = await runnerFor(t, { automate: async input => {
    active++; maxActive = Math.max(maxActive, active);
    urls.push(input.proxyUrl);
    input.onLog(`Proxy ${input.proxyUrl} user ${maskifyEnv.MASKIFY_USERNAME} password ${maskifyEnv.MASKIFY_PASSWORD}`);
    await nextTurn();
    active--;
    return { enabled: true, screenshotPath: input.screenshotPath };
  } });
  const input = accounts();
  await runner.start({ accounts: input, connectionMode: 'maskify', concurrency: 2 });
  await runner.done;
  assert.equal(maxActive, 2);
  assert.equal(new Set(urls).size, 4);
  assert.ok(urls.every(value => new URL(value).username.includes('-cc-DE-s-')));
  assert.equal(runner.run.connectionMode, 'maskify');
  assert.ok(runner.run.jobs.every(job => job.status === 'success'));
  assert.equal(input.length, 0);
  for (const secret of [...Object.values(maskifyEnv), 'test-password', 'test-api-key', ...urls]) {
    assert.equal(JSON.stringify(runner.snapshot()).includes(secret), false);
  }
});

test('missing Maskify credentials reject the run before workers start', async t => {
  let called = false;
  const runner = await runnerFor(t, { maskifyEnv: {}, automate: async () => { called = true; } });
  await assert.rejects(runner.start({ accounts: accounts(), connectionMode: 'maskify' }), /Missing Maskify credentials/);
  assert.equal(called, false);
  assert.equal(runner.run, null);
});

test('HTTP proxy mode still leases the supplied pool and limits concurrency by its size', async t => {
  const urls = [];
  const runner = await runnerFor(t, { maskifyEnv: {}, automate: async input => {
    urls.push(input.proxyUrl);
    await nextTurn();
    return { enabled: true, screenshotPath: input.screenshotPath };
  } });
  await runner.start({ accounts: accounts(), proxies: ['http://127.0.0.1:21000'], concurrency: 2 });
  await runner.done;
  assert.equal(runner.run.concurrency, 1);
  assert.deepEqual(urls, Array(4).fill('http://127.0.0.1:21000'));
  assert.ok(runner.run.jobs.every(job => job.status === 'success'));
});

async function httpApp(t) {
  const runner = await runnerFor(t);
  const assistant = Object.assign(new EventEmitter(), {
    snapshot: () => ({ active: null, records: [], phoneNumbers: [] }),
    accountsForBatch: () => accounts(),
  });
  const { app } = createApp({ runner, registrationAssistant: assistant });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { runner.stop(); await runner.done; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base)).text();
  const csrf = /name="csrf-token" content="([^"]+)"/.exec(html)[1];
  return { runner, base, csrf, html };
}

for (const saved of [false, true]) {
  test(`${saved ? 'saved-account' : 'uploaded-account'} IMAP endpoint accepts Maskify without a proxy file`, async t => {
    const { runner, base, csrf, html } = await httpApp(t);
    assert.match(html, /id="imap-connection"/);
    const form = new FormData();
    form.set('connectionMode', 'maskify');
    form.set('concurrency', '2');
    form.set('headless', 'true');
    if (saved) form.set('registrationIds', JSON.stringify(['saved-one', 'saved-two']));
    else form.set('accounts', new Blob(['first@gmx.de:password\nsecond@gmx.de:password\n']), 'accounts.txt');
    const response = await fetch(`${base}${saved ? '/api/registration-runs' : '/api/runs'}`, {
      method: 'POST', headers: { 'X-CSRF-Token': csrf }, body: form,
    });
    assert.equal(response.status, 202, await response.clone().text());
    const result = await response.json();
    assert.equal(result.run.connectionMode, 'maskify');
    assert.equal(result.run.concurrency, 2);
    await runner.done;
    assert.ok(runner.run.jobs.every(job => job.status === 'success'));
    const registrationHtml = await (await fetch(`${base}/registration`)).text();
    assert.match(registrationHtml, /id="saved-connection"/);
  });
}

test('HTTP proxy mode requires an upload and invalid connection modes are rejected', async t => {
  const { runner, base, csrf } = await httpApp(t);
  for (const mode of ['proxy', 'invalid']) {
    const form = new FormData();
    form.set('connectionMode', mode);
    form.set('concurrency', '2'); form.set('headless', 'false');
    form.set('accounts', new Blob(['first@gmx.de:password']), 'accounts.txt');
    const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'X-CSRF-Token': csrf }, body: form });
    assert.equal(response.status, 400);
  }
  assert.equal(runner.run, null);
});
