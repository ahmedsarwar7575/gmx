const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { auditPage, readFingerprint } = require('../automation/browser-diagnostics.cjs');
const { describeBrowserLaunch } = require('../automation/browser-runtime.cjs');
const { RegistrationAssistant } = require('../automation/registration.cjs');

for (const webdriver of [false, true, undefined]) {
  test(`fingerprint JSON preserves the distinction between webdriver=${webdriver}`, () => {
    const navigator = Object.freeze({ webdriver, userAgent: 'Fixture browser', platform: 'Fixture OS',
      language: 'de-DE', languages: ['de-DE', 'de'], hardwareConcurrency: 4 });
    const fingerprint = vm.runInNewContext(`(${readFingerprint.toString()})()`, {
      navigator, location: { origin: 'https://fixture.invalid', href: 'https://fixture.invalid/?token=private' },
      performance: { timeOrigin: 123 }, document: { readyState: 'complete' }, Intl,
    });
    const encoded = JSON.stringify(fingerprint), decoded = JSON.parse(encoded);
    assert.equal(decoded.webdriverType, typeof webdriver);
    assert.equal(decoded.webdriver, webdriver === undefined ? null : webdriver);
    assert.equal(decoded.origin, 'https://fixture.invalid');
    assert.equal(decoded.deviceMemory, null);
    assert.equal(encoded.includes('private'), false);
    assert.equal(navigator.webdriver, webdriver);
  });
}

test('launch diagnostics never include flag values, proxy credentials or profile paths', () => {
  const browser = { process: () => ({ spawnargs: ['/private/chrome', '--proxy-server=http://user:secret@proxy.invalid:80',
    '--user-data-dir=/private/profile', '--lang=de-DE', '--lang=de-DE', 'https://fixture.invalid/?token=secret'] }) };
  const result = describeBrowserLaunch(browser);
  assert.equal(result.available, true);
  assert.deepEqual(result.switches, ['--proxy-server', '--user-data-dir', '--lang']);
  assert.deepEqual(result.repeatedSwitches, ['--lang']);
  assert.equal(result.profileArgumentPresent, true);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|proxy\.invalid|fixture\.invalid/);
  assert.deepEqual(describeBrowserLaunch({}), { available: false, switches: [], repeatedSwitches: [], profileArgumentPresent: null });
});

test('diagnostic timeouts settle without failing the caller or logging arbitrary errors', { timeout: 2000 }, async () => {
  const logs = [];
  const result = await auditPage({ evaluate: () => new Promise(() => {}) }, { log: message => logs.push(message), timeoutMs: 10 });
  assert.equal(result, null);
  assert.match(logs[0], /BROWSER_DIAGNOSTIC_TIMEOUT/);
  await auditPage({ evaluate: async () => { throw new Error('password=private'); } }, { log: message => logs.push(message) });
  assert.match(logs[1], /EVALUATION_FAILED/);
  assert.doesNotMatch(logs.join('\n'), /private/);
});

test('a failed diagnostic sink cannot reject a successful audit', async () => {
  const fingerprint = { webdriver: false, webdriverType: 'boolean' };
  assert.deepEqual(await auditPage({ evaluate: async () => fingerprint }, { log: () => { throw new Error('sink unavailable'); } }), fingerprint);
});

test('an audit that finishes late cannot publish into the next registration session', async () => {
  const logs = [];
  const assistant = { activeId: 'first-session', stopped: false, addLog: message => logs.push(message) };
  let finish;
  const pending = RegistrationAssistant.prototype.auditBrowserPage.call(assistant, {
    evaluate: () => new Promise(resolve => { finish = resolve; }),
  }, 'navigation');
  await Promise.resolve();
  assistant.activeId = 'second-session';
  finish({ webdriver: false });
  await pending;
  assert.deepEqual(logs, []);
});
