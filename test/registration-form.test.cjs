const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { test } = require('node:test');
const puppeteer = require('puppeteer');
const { RegistrationAssistant } = require('../automation/registration.cjs');
const { readVisibleRegistrationErrors } = require('../automation/registration-errors.cjs');
const { withDeadline } = require('../async-control.cjs');

const rejection = 'Deine E-Mail-Adresse bzw. dein Account kann derzeit nicht erstellt werden. Das tut uns leid! Bitte versuche es später noch einmal.';
const profile = { firstName: 'Anna', lastName: 'Tester', birthday: '2000-02-22', gender: 'Female',
  password: 'Test-password-123!', address: { street: 'Teststrasse 1', city: 'Berlin', zipCode: '10115', country: 'Germany' } };

const profileHtml = reject => `<!doctype html><html><body>
  <form id="profile"><input id="firstName" required><input id="lastName" required>
  <input id="birthDay" type="number" required min="1" max="31">
  <input id="birthMonth" type="number" required min="1" max="12">
  <input id="birthYear" type="number" required min="1900" max="2008">
  <button type="submit" data-testid="next-button">Jetzt starten</button></form><div id="result"></div>
  <script>window.profileSubmissions=0; document.querySelector('form').onsubmit=event=>{
    event.preventDefault(); window.profileSubmissions++;
    ${reject ? "location.href='https://hilfe.gmx.net/kundenservice/flexreg.html';" : `document.querySelector('form').hidden=true;
      document.querySelector('#result').innerHTML='<form id="alias-step"><input id="alias" required><select id="domain"><option value="gmx.de">gmx.de</option></select></form>';`}
  };</script></body></html>`;

async function fixture(t, reject = false, { setupErrors = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gmx-form-fixture-'));
  let browser, purchases = 0;
  const assistant = new RegistrationAssistant({ directory, solverFactory: () => setupErrors ? {
    checkAccount: async () => {}, closeProxy: async () => {},
    preparePage: async () => { throw new Error('Preparation failed; password=private-setup-secret'); },
  } : null,
    maskifyEnv: { MASKIFY_USERNAME: 'fixture-user', MASKIFY_PASSWORD: 'fixture-password' },
    proxyIpCheck: async () => '192.0.2.1',
    purchasePhone: async () => { purchases++; throw new Error('SMS must not be reached in a profile test'); },
    launch: async options => {
      browser = await puppeteer.launch({ ...options, headless: true,
        args: [...options.args.filter(arg => !arg.startsWith('--proxy-server=')), '--no-sandbox', '--disable-dev-shm-usage'] });
      const [page] = await browser.pages();
      if (setupErrors) page.createCDPSession = async () => ({
        send: async () => { throw new Error('Locale failed; token=private-locale-secret'); },
      });
      await page.setRequestInterception(true);
      page.on('request', request => {
        const body = request.url().startsWith('https://hilfe.gmx.net/')
          ? `<!doctype html><html><body><p class="provider-message">${rejection}</p></body></html>` : profileHtml(reject);
        void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body }).catch(() => {});
      });
      return browser;
    },
  });
  assistant.printLog = () => {};
  assistant.watch = () => {};
  assistant.saveFailureImage = async () => null;
  t.after(async () => { await assistant.close(); await rm(directory, { recursive: true, force: true }); });
  return { assistant, browser: () => browser, purchases: () => purchases };
}

test('real browser fixture fills and submits the first form once, then advances to email', { timeout: 20000 }, async t => {
  const { assistant, browser, purchases } = await fixture(t);
  await assistant.start(profile, { mode: 'maskify' });
  const [page] = await browser().pages();
  await page.waitForSelector('#alias');
  assert.equal(await page.evaluate(() => window.profileSubmissions), 1);
  assert.equal(await page.$eval('#firstName', element => element.value), profile.firstName);
  assert.equal(await page.$eval('#lastName', element => element.value), profile.lastName);
  await assistant.tick();
  assert.equal(assistant.state.phase, 'email');
  assert.equal(purchases(), 0);
  assert.equal(assistant.smsController.signal.aborted, false);
  assert.equal(await page.$eval('#alias', element => element.value), assistant.store.get(assistant.activeId).candidateEmail.split('@')[0]);
  await withDeadline(async () => {
    while (!assistant.logs.some(entry => entry.message.startsWith('Fingerprint: ') && entry.message.includes('"stage":"navigation"'))) await sleep(10);
  }, 2000);
  const audit = assistant.logs.find(entry => entry.message.startsWith('Fingerprint: ') && entry.message.includes('"stage":"navigation"'));
  const fingerprint = JSON.parse(audit.message.slice('Fingerprint: '.length));
  assert.equal(fingerprint.origin, 'https://register.gmx.net');
  assert.notEqual(fingerprint.readyState, 'loading');
  assert.equal(fingerprint.webdriverType, 'boolean');
});

test('optional browser setup failures are redacted and do not prevent ordinary form progression', { timeout: 20000 }, async t => {
  const { assistant, browser, purchases } = await fixture(t, false, { setupErrors: true });
  await assistant.start(profile, { mode: 'maskify' });
  const [page] = await browser().pages();
  await page.waitForSelector('#alias');
  const logs = assistant.logs.map(entry => entry.message).join('\n');
  assert.match(logs, /Browser setup \(locale\)/);
  assert.match(logs, /Browser setup \(verification page preparation\)/);
  assert.doesNotMatch(logs, /private-setup-secret|private-locale-secret/);
  assert.equal(await page.evaluate(() => window.profileSubmissions), 1);
  assert.equal(purchases(), 0);
  assert.equal(assistant.state.status, 'running');
});

test('real browser fixture captures the visible rejection after help navigation and closes safely', { timeout: 20000 }, async t => {
  const { assistant, browser, purchases } = await fixture(t, true);
  try { await assistant.start(profile, { mode: 'maskify' }); } catch {}
  await withDeadline(async () => {
    while (!assistant.helpFailure) await sleep(10);
    await assistant.helpFailure;
  }, 5000);
  assert.equal(assistant.state.status, 'failed');
  assert.equal(assistant.state.failureCode, 'GMX_REGISTRATION_HELP');
  assert.equal(assistant.state.failurePhase, 'profile');
  assert.ok(assistant.state.stage.includes(rejection), assistant.state.stage);
  assert.equal(assistant.state.stage.includes('did not provide'), false);
  assert.equal(browser().connected, false);
  assert.equal(purchases(), 0);
});

test('visible error reader finds generic rejection text without reading hidden text or form values', { timeout: 20000 }, async t => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(() => browser.close());
  const [page] = await browser.pages();
  await page.setContent(`<input value="private-password"><p style="display:none" role="alert">hidden error</p><div style="opacity:0"><p role="alert">invisible error</p></div><p class="provider-message">${rejection}</p>`);
  assert.deepEqual(await page.evaluate(readVisibleRegistrationErrors), [rejection]);
});
