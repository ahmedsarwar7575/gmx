const assert = require('node:assert/strict');
const { access } = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const { test } = require('node:test');
const { launchRegistrationBrowser } = require('../automation/browser-runtime.cjs');
const { closeOwnedBrowser, withDeadline } = require('../async-control.cjs');

async function waitForRemoval(directory) {
  await withDeadline(async () => {
    while (true) {
      try { await access(directory); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      await sleep(20);
    }
  }, 5000);
}

test('closing one browser removes only its own temporary profile while another browser remains open', { timeout: 30000 }, async t => {
  const browsers = [];
  t.after(async () => { await Promise.allSettled(browsers.map(browser => closeOwnedBrowser(browser, 5000))); });
  const results = await Promise.allSettled(Array.from({ length: 2 }, () => launchRegistrationBrowser({
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })));
  for (const result of results) if (result.status === 'fulfilled') browsers.push(result.value);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const directories = browsers.map(browser => {
    const arg = browser.process().spawnargs.find(value => value.startsWith('--user-data-dir='));
    assert.ok(arg, 'The browser must identify its owned profile');
    return arg.slice('--user-data-dir='.length);
  });
  assert.notEqual(directories[0], directories[1]);
  await Promise.all(directories.map(directory => access(directory)));
  await browsers[0].close();
  await waitForRemoval(directories[0]);
  await access(directories[1]);
  const [page] = await browsers[1].pages();
  assert.equal(await page.evaluate(() => 6 * 7), 42);
  await browsers[1].close();
  await waitForRemoval(directories[1]);
});
