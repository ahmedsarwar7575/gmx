const fs = require('node:fs');

const path = require('node:path');

const { randomBytes, randomInt, randomUUID, createCipheriv, createDecipheriv, createHmac } = require('node:crypto');

const { DatabaseSync } = require('node:sqlite');

const { EventEmitter } = require('node:events');

const { isIP } = require('node:net');

const { setTimeout: sleep } = require('node:timers/promises');

const puppeteer = require('puppeteer');

const { Router } = require('express');
const multer = require('multer');

const { generateProfile, getSMS } = require('../random.js');

const { createMaskifyProxy } = require('../maskify.cjs');

const { createCaptchaSolver } = require('./captcha-solver.cjs');

const { checkProxyIp } = require('../proxy-ip.cjs');

const { registrationConnection } = require('../registration-connection.cjs');
const { captureFailure } = require('../artifacts.cjs');



const PROJECT_ROOT = path.resolve(__dirname, '..');





function emailHint(value) {

  if (typeof value !== "string" || !value.includes("@")) return "Email not chosen yet";

  const [user, domain] = value.split("@");

  return `${user.slice(0, 1)}•••@${domain}`;

}

function isMailboxUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port
      && (url.hostname === 'navigator.gmx.net' || url.hostname.endsWith('.navigator.gmx.net'))
      && ['/mail', '/mail/'].includes(url.pathname);
  } catch { return false; }
}

function isRegistrationHelpUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://hilfe.gmx.net' && url.pathname === '/kundenservice/flexreg.html';
  } catch { return false; }
}

function isVerifiedRegistration(record) {
  return record?.status === 'complete' && record.completionSource === 'mailbox_redirect'
    && typeof record.completionOrigin === 'string' && isMailboxUrl(`${record.completionOrigin}/mail`)
    && new URL(record.completionOrigin).origin === record.completionOrigin;
}



class RegistrationStore {

  constructor(directory = path.join(PROJECT_ROOT, "data")) {

    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

    fs.chmodSync(directory, 0o700);

    this.keyPath = path.join(directory, "registration.key");

    if (!fs.existsSync(this.keyPath)) {

      const key = randomBytes(32);

      try { fs.writeFileSync(this.keyPath, key, { flag: "wx", mode: 0o600 }); }

      catch (error) { if (error.code !== "EEXIST") throw error; }

      key.fill(0);

    }

    const stat = fs.lstatSync(this.keyPath);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) throw new Error("Registration encryption key is invalid.");

    fs.chmodSync(this.keyPath, 0o600);

    this.key = fs.readFileSync(this.keyPath);

    this.dbPath = path.join(directory, "registrations.sqlite");

    this.db = new DatabaseSync(this.dbPath);

    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS registrations (id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL, secret BLOB NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");

    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS registration_exit_ips (fingerprint TEXT PRIMARY KEY, registration_id TEXT NOT NULL, reserved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS registration_phone_numbers (fingerprint TEXT PRIMARY KEY, registration_id TEXT NOT NULL, reserved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS registration_batches (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE TABLE IF NOT EXISTS registration_batch_accounts (batch_id TEXT NOT NULL, registration_id TEXT NOT NULL UNIQUE, PRIMARY KEY(batch_id, registration_id));`);

    fs.chmodSync(this.dbPath, 0o600);

    this.seedPhoneReservations();

  }



  seal(value) {

    const nonce = randomBytes(12);

    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);

    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);

    return Buffer.concat([nonce, cipher.getAuthTag(), data]);

  }



  open(blob) {

    const nonce = blob.subarray(0, 12), tag = blob.subarray(12, 28), data = blob.subarray(28);

    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);

    decipher.setAuthTag(tag);

    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));

  }



  create(profile, status = "starting", stage = "Preparing GMX registration") {

    const id = randomUUID(), now = Date.now();

    this.db.prepare("INSERT INTO registrations (id,status,stage,secret,created_at,updated_at) VALUES (?,?,?,?,?,?)")

      .run(id, status, stage, this.seal(profile), now, now);

    return id;

  }



  get(id) {

    const row = this.db.prepare("SELECT * FROM registrations WHERE id=?").get(id);

    return row ? { ...row, ...this.open(row.secret) } : null;

  }



  update(id, { status, stage, ...patch }) {

    const row = this.db.prepare("SELECT * FROM registrations WHERE id=?").get(id);

    if (!row) throw new Error("Registration record not found.");

    const secret = this.open(row.secret);

    for (const [key, value] of Object.entries(patch)) secret[key] = value;

    const nextStatus = status ?? row.status, nextStage = stage ?? row.stage;

    this.db.prepare("UPDATE registrations SET status=?,stage=?,secret=?,updated_at=? WHERE id=?")

      .run(nextStatus, nextStage, this.seal(secret), Date.now(), id);

  }



  list() {

    return this.db.prepare("SELECT id,status,stage,secret,created_at,updated_at FROM registrations ORDER BY created_at DESC LIMIT 100")

      .all().map((row) => {

        const secret = this.open(row.secret);

        return { id: row.id, status: row.status, stage: row.stage, emailHint: emailHint(secret.email),

          createdAt: row.created_at, updatedAt: row.updated_at };

      });

  }



  markInterrupted() {

    this.db.prepare("UPDATE registrations SET status='paused',stage='Server restarted · start the profile again',updated_at=? WHERE status NOT IN ('paused','user_confirmed','failed','complete','cancelled')")

      .run(Date.now());

    this.db.prepare("UPDATE registration_batches SET status='interrupted',finished_at=? WHERE status='running'").run(Date.now());

  }

  reserveExitIp(ip, id) {
    if (!isIP(ip)) throw new Error('Proxy IP check returned an invalid IP address.');
    // Normalize IPv6 spellings and IPv4-mapped IPv6 before making an atomic,
    // durable reservation. Failed attempts deliberately keep their reservation.
    let canonical = isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
    const mapped = canonical.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
    if (mapped) {
      const value = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16);
      canonical = [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
    }
    const fingerprint = createHmac('sha256', this.key).update(canonical).digest('hex');
    const result = this.db.prepare('INSERT OR IGNORE INTO registration_exit_ips VALUES (?,?,?)').run(fingerprint, id, Date.now());
    if (!result.changes) throw Object.assign(new Error('This proxy exit IP was already used for a registration attempt. Supply a different exit IP.'), { code: 'IP_REUSED' });
  }

  phoneFingerprint(record) {
    const details = phoneDetails(record.phone, record.phoneCountryCode || '', record.country || '');
    const canonical = `${details.phoneCountryCode || ''}${details.phone || ''}`;
    if (!/^\+[1-9]\d{7,14}$/.test(canonical)) throw new Error('Enter a valid international phone number.');
    return createHmac('sha256', this.key).update(`phone\0${canonical}`).digest('hex');
  }

  seedPhoneReservations() {
    // Include numbers saved before phone tracking was added. Old duplicates
    // belong to the earliest saved registration and stay blocked for new ones.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO registration_phone_numbers VALUES (?,?,?)');
      for (const row of this.db.prepare('SELECT id,secret,created_at FROM registrations ORDER BY created_at,id').iterate()) {
        const record = this.open(row.secret);
        if (!record.phone) continue;
        let fingerprint;
        try { fingerprint = this.phoneFingerprint(record); } catch { continue; }
        insert.run(fingerprint, row.id, row.created_at);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reservePhone(details, id) {
    const fingerprint = this.phoneFingerprint(details);
    this.db.prepare('INSERT OR IGNORE INTO registration_phone_numbers VALUES (?,?,?)').run(fingerprint, id, Date.now());
    const owner = this.db.prepare('SELECT registration_id FROM registration_phone_numbers WHERE fingerprint=?').get(fingerprint);
    if (owner?.registration_id !== id) throw Object.assign(new Error('This phone number was already assigned to another registration. Use a different number.'), { code: 'PHONE_REUSED' });
  }

  createBatch(id) { this.db.prepare("INSERT INTO registration_batches VALUES (?,'running',?,NULL)").run(id, Date.now()); }
  finishBatch(id, status) { this.db.prepare('UPDATE registration_batches SET status=?,finished_at=? WHERE id=?').run(status, Date.now(), id); }
  linkBatchAccount(batchId, id) { this.db.prepare('INSERT OR IGNORE INTO registration_batch_accounts VALUES (?,?)').run(batchId, id); }
  exportBatch(id) {
    const batch = this.db.prepare('SELECT status FROM registration_batches WHERE id=?').get(id);
    if (!batch) throw new Error('Registration batch not found.');
    if (batch.status === 'running') throw new Error('Wait for the registration batch to finish before downloading.');
    const seen = new Set(), lines = [];
    for (const row of this.db.prepare('SELECT registration_id FROM registration_batch_accounts WHERE batch_id=? ORDER BY rowid').all(id)) {
      const record = this.get(row.registration_id);
      if (!isVerifiedRegistration(record) || !/^[^\s:@]+@gmx\.de$/i.test(record.email || '')
        || typeof record.password !== 'string' || !record.password || /[\r\n]/.test(record.password) || seen.has(record.email.toLowerCase())) continue;
      seen.add(record.email.toLowerCase());
      lines.push(`${record.email}:${record.password}`);
    }
    return lines.length ? lines.join('\n') + '\n' : '';
  }



  close() { this.db.close(); this.key.fill(0); }

}



function generatePassword() {

  const lower = "abcdefghijkmnopqrstuvwxyz";

  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";

  const digits = "23456789";

  const symbols = "!@#$%*-_";

  const pick = (chars) => chars[randomInt(chars.length)];

  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];

  const all = lower + upper + digits + symbols;

  while (chars.length < 20) chars.push(pick(all));

  for (let i = chars.length - 1; i > 0; i--) {

    const j = randomInt(i + 1);

    [chars[i], chars[j]] = [chars[j], chars[i]];

  }

  return chars.join("");

}



function emailCandidate(first, last) {

  const normalize = (value) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");

  const base = [normalize(first), normalize(last)].filter(Boolean).join(".").slice(0, 24) || "mailbox";

  return `${base}.${randomBytes(3).toString("hex")}@gmx.de`;

}



const dom = (() => {

  async function nodes(frame, selector) {

    const array = await frame.evaluateHandle((selector) => {

      const roots = [document], found = [];

      for (const root of roots) for (const el of root.querySelectorAll('*')) {

        if (el.shadowRoot) roots.push(el.shadowRoot);

        if (el.matches(selector) && el.getBoundingClientRect().width > 0

          && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden') found.push(el);

      }

      return found;

    }, selector);

    try { return [...(await array.getProperties()).values()].map(value => value.asElement()).filter(Boolean); }

    finally { await array.dispose(); }

  }



  async function fill(frame, id, value) {

    const fields = await nodes(frame, `[id=${JSON.stringify(id)}]`);

    try {

      if (fields.length !== 1) throw new Error(`Expected one visible GMX ${id} field.`);

      await fields[0].asLocator().fill(value);

      await fields[0].evaluate(el => el.blur());

    } finally { await Promise.all(fields.map(field => field.dispose())); }

  }



  async function select(frame, id, value) {

    const fields = await nodes(frame, `[id=${JSON.stringify(id)}]`);

    try {

      if (fields.length !== 1) throw new Error(`Expected one visible GMX ${id} selector.`);

      const options = await fields[0].evaluate(el => [...el.options].map(o => ({ value: o.value, text: o.textContent.trim() })));

      const countryAliases = { germany: 'DE', deutschland: 'DE', switzerland: 'CH', schweiz: 'CH', austria: 'AT', österreich: 'AT' };

      const normalized = value.toLowerCase();

      const option = options.find(o => o.value.toLowerCase() === normalized || o.text.toLowerCase().replace(/^@/, '') === normalized)

        || options.find(o => o.value.toUpperCase() === countryAliases[normalized]);

      if (!option) throw new Error(`GMX does not offer the selected ${id} option. Check the dashboard details.`);

      await fields[0].select(option.value);

    } finally { await Promise.all(fields.map(field => field.dispose())); }

  }



  async function read(frame) {

    return frame.evaluate(() => {

      const roots = [document], all = [];

      for (const root of roots) for (const el of root.querySelectorAll('*')) {

        if (el.shadowRoot) roots.push(el.shadowRoot);

        all.push(el);

      }

      const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';

      const controls = all.filter(el => el.matches('input,select,textarea') && visible(el));

      const fields = controls.map(el => ({ id: el.id, name: el.name, type: el.type, tag: el.tagName,

        label: el.labels?.[0]?.textContent?.trim().slice(0, 80) || el.getAttribute('aria-label') || el.id,

        required: el.required, valid: el.validity?.valid !== false, filled: !!el.value,

        disabled: el.disabled || el.matches(':disabled'), checked: el.checked,

        choice: el.type === 'radio' ? el.value : undefined }));

      const widget = all.find(el => el.matches('#captchafox,.captchafox') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');

      const solved = widget && (!!widget.querySelector('[name="cf-captcha-response"]')?.value

        || !!widget.querySelector('[role="checkbox"][aria-checked="true"]'));

      const modal = all.some(el => el.matches('.cf-modal__wrap,.cf-modal__challenge,#container-captcha') && visible(el));

      const alias = controls.find(el => el.id === 'alias'), domain = controls.find(el => el.id === 'domain');

      const displayed = all.find(el => el.matches('.congrats__email') && visible(el));

      let email = displayed?.textContent?.trim() || (alias?.value && domain?.value ? `${alias.value}@${domain.value.replace(/^@/, '')}` : null);

      const next = all.find(el => el.matches('button[data-testid="next-button"]') && visible(el))

        || all.find(el => el.matches('button[type="submit"]') && visible(el) && /^(get started|continue|next|weiter|verify|confirm|create (your )?account|i agree.*)$/i.test(el.textContent.trim()));

      const successMarker = all.some(el => el.id === 'terms_and_conditions_successful_registration' && visible(el));

      const visibleText = roots.flatMap(root => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), texts = [];
        let node;
        while ((node = walker.nextNode())) if (node.parentElement && visible(node.parentElement)) texts.push(node.textContent.trim());
        return texts;
      }).join(' ');
      const summaryEmails = [...new Set((visibleText.match(/[A-Z0-9._%+-]+@gmx\.de\b/gi) || []).map(value => value.toLowerCase()))];
      const finalHeading = all.some(el => visible(el) && el.matches('h1,h2,h3,[role="heading"]') && /^Perfekt\s*!?$/i.test(el.textContent.trim()));
      // Capture the chosen address on the final panel, then continue waiting
      // for the actual mailbox redirect. A panel or OTP alone is insufficient.
      const summaryPage = finalHeading && summaryEmails.length === 1 && /GMX\s*FreeMail/i.test(visibleText)
        && /E-Mail\s*:/i.test(visibleText) && /Cloud\s*:/i.test(visibleText) && /News\s*:/i.test(visibleText)
        && /Vertragszusammenfassung|Zustimmen\s+und\s+weiter/i.test(visibleText);
      if (summaryPage) email = summaryEmails[0];

      const errors = all.filter(el => visible(el) && (el.matches('[role="alert"],[id$="-error"]'))).map(el => el.textContent.trim()).filter(Boolean);
      if (summaryPage && !errors.length && /da ist etwas schiefgelaufen|logge dich bitte über die homepage ein/i.test(visibleText)) {
        errors.push('GMX reported an error opening the mailbox.');
      }

      return { documentId: performance.timeOrigin, fields, captcha: !!modal || !!widget && !solved, modal,

        email: /@gmx\.de$/i.test(email || '') ? email : null, displayedEmail: !!displayed,

        wrongDomain: !!email && !/@gmx\.de$/i.test(email), aliasAvailable: !!alias?.classList.contains('alias-step__form-element--available'),

        success: false, summaryPage: summaryPage || successMarker, errors, next: !!next, nextDisabled: !next || next.disabled || next.getAttribute('aria-busy') === 'true',

        suggestionCount: all.filter(el => el.matches('button.chip[data-testid^="chip-"]') && visible(el)).length,

        forms: all.filter(el => el.tagName === 'FORM' && visible(el)).map(el => el.id) };

    });

  }



  function phaseOf(view) {

    const ids = view.fields.map(field => field.id);

    if (ids.some(id => /^confirmationCode\.\d+\.digit$/.test(id)) || ids.includes('verificationCode')) return 'otp';

    if (view.summaryPage) return 'confirmation';

    if (ids.includes('firstName')) return 'profile';

    if (ids.includes('alias') || view.forms.includes('alias-step') || view.displayedEmail) return 'email';

    if (ids.includes('password') || ids.includes('confirmPassword')) return 'password';

    if (ids.includes('mobilePhone')) return 'phone';

    if (ids.some(id => ['country', 'postalCode', 'city', 'street'].includes(id))) return 'address';

    if (view.next) return 'confirmation';

    return 'unknown';

  }



  async function scan(browser) {

    let candidate;

    const pages = (await browser.pages()).reverse();
    const help = pages.find(page => isRegistrationHelpUrl(page.url()));
    if (help) return { registrationHelp: true, page: help, phase: 'unknown' };
    // Only a top-level GMX mailbox navigation confirms success. Embedded URLs
    // and URLs merely mentioning GMX must not complete a registration.
    const mailbox = pages.find(page => isMailboxUrl(page.url()));
    if (mailbox) return { success: true, mailboxRedirect: true, phase: 'confirmation',
      page: mailbox, frame: mailbox.mainFrame(), email: null, captcha: false };

    for (const page of pages) for (const frame of page.frames()) {

      if (!/^https:\/\/register\.gmx\.net(?:\/|$)/.test(frame.url())) continue;

      if (frame.parentFrame()) {

        const host = await frame.frameElement();

        if (!host) continue;

        const visible = await host.isVisible(); await host.dispose();

        if (!visible) continue;

      }

      const view = await read(frame);

      view.phase = phaseOf(view);

      view.key = `${view.documentId}:${view.phase}:${view.fields.map(field => field.id).join('|')}:${view.phase === 'email' ? `${view.aliasAvailable}:${view.suggestionCount}` : ''}`;

      const result = { ...view, frame, page };

      if (view.success || view.phase !== 'unknown') return result;

      candidate ||= result;

    }

    return candidate;

  }



  async function next(frame) {

    const buttons = await nodes(frame, 'button[data-testid="next-button"],button[type="submit"]');

    try {

      const button = buttons.find(Boolean);

      if (!button || await button.evaluate(el => el.disabled || el.getAttribute('aria-busy') === 'true')) return false;

      await button.click();

      return true;

    } finally { await Promise.all(buttons.map(button => button.dispose())); }

  }



  async function chooseSuggestion(frame) {

    const choices = await nodes(frame, 'button.chip[data-testid^="chip-"]');

    try {

      for (const choice of choices) {

        const match = await choice.evaluate(el => !el.disabled && /@gmx\.de$/i.test(el.textContent.trim()));

        if (match) { await choice.click(); return true; }

      }

      return false;

    } finally { await Promise.all(choices.map(choice => choice.dispose())); }

  }

  return { nodes, fill, select, read, scan, next, chooseSuggestion, phaseOf };

})();



const FIRST_STEP = { firstName: 'input#firstName[name="firstName"]', lastName: '#lastName', day: '#birthDay', month: '#birthMonth', year: '#birthYear', captcha: '#captchafox', continue: 'button[data-testid="next-button"]' };

const terminal = new Set(['paused', 'complete', 'user_confirmed', 'failed']);



function phoneDetails(phone = '', countryCode = '', country = '') {

  if (!phone) return { phone: null, phoneCountryCode: null };

  if (typeof phone !== 'string' || typeof countryCode !== 'string') throw new Error('Enter a valid phone number and calling code.');

  let number = phone.replace(/[ ()-]/g, ''), prefix = countryCode;

  if (number.startsWith('00')) number = `+${number.slice(2)}`;

  const defaultPrefix = /^(germany|deutschland|de)$/i.test(country) ? '+49' : /^(switzerland|schweiz|ch)$/i.test(country) ? '+41' : /^(austria|österreich|at)$/i.test(country) ? '+43' : '';

  if (number.startsWith('+')) {

    prefix ||= defaultPrefix;

    if (!prefix || !number.startsWith(prefix)) throw new Error('Enter the country calling code separately for this phone number.');

    number = number.slice(prefix.length);

  }

  prefix ||= defaultPrefix;

  if (['+49', '+41', '+43'].includes(prefix)) number = number.replace(/^0+/, '');

  if (!/^\+\d{1,4}$/.test(prefix) || !/^\d{6,15}$/.test(number)) throw new Error('Enter a valid phone number and country calling code.');

  return { phone: number, phoneCountryCode: prefix };

}



function validateProfile(input = {}) {

  const source = { ...input, birthDate: input.birthDate || input.birthday,

    gender: typeof input.gender === 'string' ? input.gender.toLowerCase() : 'unspecified',

    postalCode: input.postalCode || input.address?.zipCode, city: input.city || input.address?.city,

    street: input.street || input.address?.street, country: input.country || input.address?.country };

  const fields = ['firstName', 'lastName', 'birthDate', 'gender', 'postalCode', 'city', 'street', 'country'];

  for (const field of fields) if (typeof source[field] !== 'string' || !source[field].trim()) throw new Error(`Enter ${field.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`)}.`);

  const profile = Object.fromEntries(fields.map(field => [field, source[field].trim()]));

  if (profile.firstName.length > 80 || profile.lastName.length > 80 || profile.street.length > 160 || profile.city.length > 100 || profile.country.length > 80 || profile.postalCode.length > 24) throw new Error('One of the profile fields is too long.');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.birthDate)) throw new Error('Enter a valid date of birth.');

  const date = new Date(`${profile.birthDate}T00:00:00Z`);

  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== profile.birthDate || date > new Date()) throw new Error('Enter a valid date of birth.');

  if (!['female', 'male', 'diverse', 'unspecified'].includes(profile.gender)) throw new Error('Choose a gender option.');

  if (input.password && (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128)) throw new Error('The password must contain 8–128 characters.');

  if (input.confirmPassword && input.confirmPassword !== input.password) throw new Error('The passwords do not match.');

  if (input.email && (typeof input.email !== 'string' || !/^[^\s@]+@gmx\.de$/i.test(input.email))) throw new Error('The requested email must end in @gmx.de.');

  if (input.heroSMS != null) {

    const activationId = input.heroSMS.activationId;

    if (!input.phone || !['string', 'number'].includes(typeof activationId) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(activationId))) throw new Error('A HeroSMS phone number requires a valid activation ID.');

    profile.heroSMS = { activationId: String(activationId) };

  }

  return { ...profile, ...phoneDetails(input.phone, input.countryCode, profile.country), password: input.password || generatePassword(), requestedEmail: input.email || null };

}



class RegistrationAssistant extends EventEmitter {

  constructor({ directory = path.join(PROJECT_ROOT, 'data'), launch = options => puppeteer.launch(options), pollMs = 600, transitionMs = 60_000,

    maskifyEnv = null, solverFactory = createCaptchaSolver, proxyIpCheck = checkProxyIp, purchasePhone = null,

    smsClient = getSMS, smsPollMs = 5_000, smsTimeoutMs = 360_000, store = null, logLabel = '' } = {}) {

    super();

    this.ownsStore = !store;
    this.store = store || new RegistrationStore(directory);
    if (this.ownsStore) this.store.markInterrupted();

    Object.assign(this, { launch, pollMs, transitionMs, solver: null, maskifyEnv, solverFactory, proxyIpCheck, purchasePhone, smsClient, smsPollMs, smsTimeoutMs, logLabel, browser: null, page: null, activeId: null, state: null, timer: null, work: null, stopped: true, logs: [] });

  }

  createWorker({ logLabel = '' } = {}) {
    return new RegistrationAssistant({ store: this.store, launch: this.launch, pollMs: this.pollMs, transitionMs: this.transitionMs,
      maskifyEnv: this.maskifyEnv, solverFactory: this.solverFactory, proxyIpCheck: this.proxyIpCheck,
      purchasePhone: this.purchasePhone, smsClient: this.smsClient, smsPollMs: this.smsPollMs, smsTimeoutMs: this.smsTimeoutMs, logLabel });
  }

  snapshot() { return { active: this.state ? { ...this.state, browserOpen: !!this.browser?.connected,

    smsRetryAvailable: this.state.status === 'awaiting_otp' && !!this.browser?.connected && !!this.smsPoll?.retryable && !!this.smsPoll?.finished,

    logs: this.logs.slice(-20) } : null, records: this.store.list() }; }

  publish() { this.emit('state', this.snapshot()); }

  printLog(message) {
    const label = this.logLabel || (this.activeId ? `Session ${this.activeId.slice(0, 8)}` : 'Assistant');
    console.log(`[${label}] ${message}`);
  }

  addLog(message) {

    message = this.safeError(message).slice(0, 2000);

    this.logs.push({ time: Date.now(), message });

    this.logs = this.logs.slice(-40);

    this.publish();

    this.printLog(message);

  }



  setState(status, stage, phase = this.state?.phase || 'profile') {

    if (this.stopped && (status === 'running' || status === 'needs_attention' || status.startsWith('awaiting_'))) return;

    stage = this.safeError(stage).slice(0, 2000);

    if (status.startsWith('awaiting_')) this.unknownSince = null;

    if (status === 'needs_attention') this.attentionKey = this.currentKey;

    if (this.state?.status === status && this.state?.stage === stage && this.state?.phase === phase) return;

    this.state = { ...this.state, status, stage, phase, updatedAt: Date.now() };

    this.store.update(this.activeId, { status, stage });

    const message = ['failed', 'cancelled', 'paused', 'needs_attention'].includes(status) ? `[${status.toUpperCase()}] ${stage}` : stage;
    this.logs.push({ time: Date.now(), message }); this.logs = this.logs.slice(-40); this.publish();

    this.printLog(message);

  }

  recordFailure(code, reason, { phase = this.state?.phase || 'startup', status = 'failed' } = {}) {
    this.state = { ...this.state, failureCode: code, failurePhase: phase };
    this.store.update(this.activeId, { failureCode: code, failurePhase: phase });
    const action = status === 'needs_attention' ? 'Needs attention' : status === 'cancelled' ? 'Cancelled' : 'Stopped';
    this.setState(status, `${action} at ${phase.replace(/_/g, ' ')} step (${code}): ${this.safeError(reason)}`);
  }

  recordRequestIssue(request, { httpStatus, errorCode } = {}) {
    if (this.stopped || !this.state || terminal.has(this.state.status)) return false;
    let url;
    try { url = new URL(request.url()); } catch { return false; }
    if (url.origin !== 'https://register.gmx.net' || !['document', 'xhr', 'fetch'].includes(request.resourceType())) return false;
    const code = Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? `HTTP_${httpStatus}`
      : /^ERR_[A-Z_]{1,70}$/.test(errorCode || '') ? errorCode : null;
    if (!code) return false;
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(request.method()) ? request.method() : 'REQUEST';
    const phase = this.state.phase || 'unknown', previous = this.lastRequestIssue;
    this.lastRequestIssue = { code, method, phase, time: Date.now() };
    if (!previous || previous.code !== code || previous.method !== method || previous.phase !== phase || Date.now() - previous.time > 30_000) {
      this.addLog(`Observed GMX ${method} request failure: ${code} during ${phase} step.`);
    }
    return true;
  }

  safeError(error) {

    let text = String(error?.message || error || 'Registration browser error');

    const record = this.activeId && this.store.get(this.activeId);

    for (const value of [record?.password, record?.phone, record?.heroSMS?.activationId, this.maskifyEnv?.ANYSOLVER_API_KEY, this.maskifyEnv?.HEROSMS_API_KEY, ...(this.redactions || [])]) if (value) text = text.split(value).join('[hidden]');

    return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email hidden]')

      .replace(/\b(sid|session|token|activationId|api_key|password)\s*[=:]\s*["']?[^\s"'&<>]+/gi, '$1=[hidden]')

      .replace(/https?:\/\/[^\s"'<>]+/g, value => { try { return new URL(value).origin; } catch { return '[URL hidden]'; } });

  }

  async start(input, options) {

    if (this.starting || this.browser?.connected) throw new Error('Finish or close the open GMX registration before starting another.');

    const connection = registrationConnection(options);
    const profile = validateProfile(input);

    this.starting = true;

    try {

      if (this.browserCleanup) await this.browserCleanup;

      const id = this.store.create({ ...profile, email: null, candidateEmail: profile.requestedEmail || emailCandidate(profile.firstName, profile.lastName) });

      Object.assign(this, { activeId: id, logs: [], redactions: new Set(), currentKey: null, attentionKey: null, prepared: null, submitted: null, pendingCode: null, otpReady: false,

        phoneApproved: !!profile.phone, phonePurchaseStatus: profile.phone ? 'provided' : 'idle', failures: 0, unknownSince: null, manualCaptcha: null, stopped: false,

        smsController: new AbortController(), exitIpReserved: false, smsResendAttempted: false, lastRequestIssue: null, lastVisibleError: null, failureCapture: null,

        smsPoll: profile.heroSMS ? { activationId: profile.heroSMS.activationId, deadline: null, nextAt: 0, finished: false, retryable: false, providerStatus: null } : null,

        state: { id, status: 'starting', phase: 'profile', stage: 'Opening GMX registration', connectionMode: connection.mode, emailHint: 'Email not chosen yet', passwordReady: true, updatedAt: Date.now() } });

      this.publish();

      if (profile.phone) this.store.reservePhone(profile, id);



      const maskify = connection.mode === 'maskify' && this.maskifyEnv

        ? createMaskifyProxy(this.maskifyEnv, { optional: true }) : null;

      if (connection.mode === 'maskify' && !maskify) throw new Error('Maskify API mode requires MASKIFY_USERNAME and MASKIFY_PASSWORD in .env.');

      const browserProxy = connection.mode === 'proxy' ? connection.proxy : maskify;



      this.solver = null;

      if (connection.mode === 'proxy') {

        for (const secret of [options.proxyText, browserProxy.url, browserProxy.username, browserProxy.password]) if (secret) this.redactions.add(secret);

        this.addLog('Uploaded HTTP proxy selected.');

      }

      if (maskify) {

        for (const secret of [maskify.username, maskify.password, maskify.url]) this.redactions.add(secret);

        this.solver = this.solverFactory({ ...this.maskifyEnv, GMX_PROXY_URL: maskify.url }, {

          log: message => this.addLog(`Solver: ${message}`),
          signal: this.smsController.signal,

        });

        this.addLog('Using a Maskify German sticky session for registration and CAPTCHA.');

      }

      const proxyArg = browserProxy?.argument || null;

      if (this.solver) { 

        this.addLog('Solver detected. Checking balance...');

        await this.solver.checkAccount(); 

      } else {

        this.addLog(connection.mode === 'proxy'

          ? 'Verification is completed manually in Chrome for this connection.'

          : 'No solver configured. CAPTCHA will need to be solved manually.');

      }



      if (!proxyArg) throw new Error('Registration requires Maskify or an uploaded HTTP proxy.');

      this.smsController.signal.throwIfAborted();

      const userDataDir = path.join(path.dirname(this.store.dbPath), 'browser-profiles', id);

      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });

      const profileDirectory = path.join(userDataDir, 'Default');
      fs.mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(profileDirectory, 'Preferences'), JSON.stringify({
        credentials_enable_service: false, credentials_enable_autosignin: false,
        autofill: { profile_enabled: false, credit_card_enabled: false },
        webrtc: { ip_handling_policy: 'disable_non_proxied_udp' },
        profile: { default_content_setting_values: { geolocation: 2, media_stream_camera: 2, media_stream_mic: 2, notifications: 2 } },
      }), { flag: 'wx', mode: 0o600 });

      this.browser = await this.launch({

        headless: false,

        defaultViewport: null,

        timeout: 60_000,

        userDataDir,

        args: [

          '--start-maximized',

          '--lang=de-DE',

          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',

          '--dns-prefetch-disable',

          '--disable-background-networking',

          '--disable-quic',

          '--proxy-bypass-list=<-loopback>',

          ...(proxyArg ? [proxyArg] : []),

          ...(process.platform === 'linux' && process.env.DISPLAY ? ['--ozone-platform=x11'] : [])

        ]

      });

      this.smsController.signal.throwIfAborted();



      const installed = new WeakMap();

      const install = page => {

        if (!installed.has(page)) installed.set(page, (async () => {

          page.setDefaultTimeout(30_000);

          page.on('framenavigated', frame => {
            if (frame === page.mainFrame() && isRegistrationHelpUrl(frame.url())) {
              void this.failRegistrationHelp(page).catch(() => {});
            }
          });

          await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' });

          if (typeof page.createCDPSession === 'function') {

            const session = await page.createCDPSession().catch(() => null);

            if (session) await session.send('Emulation.setLocaleOverride', { locale: 'de-DE' }).catch(() => {});

          }

          page.on('requestfailed', request => {

            const errorText = request.failure()?.errorText || '';
            const code = errorText.match(/\bnet::(ERR_[A-Z_]+)/)?.[1];
            const recorded = this.recordRequestIssue(request, { errorCode: code });

            if (!recorded && /ERR_(PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|NO_SUPPORTED_PROXIES|PROXY_AUTH_UNSUPPORTED)/.test(errorText)) {

              this.addLog(`Browser proxy request failed (${code || 'PROXY_ERROR'}).`);

            }

          });

          page.on('response', response => {
            if (response.status() >= 400) this.recordRequestIssue(response.request(), { httpStatus: response.status() });
          });

          if (browserProxy && (browserProxy.username !== undefined || browserProxy.password !== undefined)) {

            await page.authenticate({ username: browserProxy.username || '', password: browserProxy.password || '' });

          }

          await this.solver?.preparePage(page).catch(() => {});

        })());

        return installed.get(page);

      };

      this.browser.on('targetcreated', async target => {

        if (target.type() !== 'page') return;

        const page = await target.page().catch(() => null);

        if (page) await install(page).catch(() => {});

      });



      this.page = (await this.browser.pages())[0] || await this.browser.newPage();

      await install(this.page);

      if (proxyArg) {

        this.addLog('Checking the proxy public IP...');

        const ip = await this.proxyIpCheck(this.page, { log: message => this.addLog(message), signal: this.smsController.signal });

        if (ip == null) {

          throw Object.assign(new Error('Proxy public IP could not be verified. Registration stopped before visiting GMX.'), { code: 'IP_UNVERIFIED' });

        } else {

          if (!isIP(ip)) throw new Error('Proxy IP check returned an invalid IP address.');

          this.store.reserveExitIp(ip, id);

          this.exitIpReserved = true;

          this.addLog(`Proxy public IP: ${ip}`);

        }

      }

      this.addLog('Opening GMX registration...');

      for (let attempt = 0; attempt < 2; attempt++) {

        try {

          this.smsController.signal.throwIfAborted();

          if (attempt) {




            const previous = this.page;

            const replacement = await this.browser.newPage();

            this.smsController.signal.throwIfAborted();

            await install(replacement);

            this.smsController.signal.throwIfAborted();

            this.page = replacement;

            if (previous && !previous.isClosed()) await previous.close().catch(() => {});

            await replacement.bringToFront();

          }

          await this.page.goto('https\://register.gmx.net/', { waitUntil: 'domcontentloaded', timeout: 120_000 });

          const deadline = Date.now() + 120_000;

          while (true) {

            const initial = await dom.scan(this.browser);
            if (initial?.registrationHelp) {
              await this.failRegistrationHelp(initial.page);
              throw new Error('GMX redirected to registration help. The attempt was stopped.');
            }
            if (initial?.success || initial?.phase === 'profile' || initial?.summaryPage) break;

            if (this.stopped) throw new Error('Registration was closed.');

            if (Date.now() > deadline) throw Object.assign(new Error('GMX did not show its first registration form within 120 seconds.'), { name: 'TimeoutError' });

            await sleep(300);

          }

          break;

        } catch (error) {

          this.smsController.signal.throwIfAborted();

          const code = String(error?.message || '').match(/\bnet::(ERR_[A-Z_]+)/)?.[1];

          const detached = /not attached to an active page|session (?:closed|with given id not found)|navigating frame was detached|attempted to use detached frame/i.test(error?.message || '');

          if (code !== 'ERR_TIMED_OUT' && error?.name !== 'TimeoutError' && !detached) throw error;

          if (!attempt && !this.stopped && this.browser?.connected && !this.page?.isClosed()) {

            this.addLog(`GMX ${detached ? 'page connection was lost' : 'page load timed out'}. Reopening once in a fresh tab with the same browser profile and proxy session.`);

            continue;

          }

          const route = maskify ? ' through Maskify' : connection.mode === 'proxy' ? ' through the uploaded HTTP proxy' : proxyArg ? ' through the configured proxy' : '';

          const check = proxyArg ? 'Check the proxy connection to register.gmx.net.' : 'Check the connection to register.gmx.net.';

          throw new Error(`GMX registration ${detached ? 'lost its page connection' : 'timed out'}${route} after one retry (${detached ? 'PAGE_DETACHED' : code || 'NAVIGATION_TIMEOUT'}). ${check} Reload this Chrome window when the connection works, then click Retry current step to reuse the saved profile and phone number.`);

        }

      }

      await this.tick(); this.watch(); return this.snapshot();

    } catch (error) {

      const blocked = !this.exitIpReserved;
      if (this.state && !this.stopped) {
        const code = ['IP_REUSED', 'IP_UNVERIFIED', 'PHONE_REUSED'].includes(error?.code) ? error.code : 'STARTUP_FAILED';
        this.recordFailure(code, error, { phase: code.startsWith('IP_') ? 'proxy_check' : this.state.phase, status: blocked ? 'failed' : 'needs_attention' });
      }

      if (blocked || this.stopped) await this.closeBrowser();

      if (!this.browser?.connected) await this.solver?.closeProxy().catch(() => {});

      throw new Error(this.safeError(error));

    } finally { this.starting = false; }

  }

  watch() {

    if (this.stopped || this.timer || this.work) return;

    this.timer = setTimeout(async () => {

      this.timer = null;

      this.work = this.tick().catch(error => {

        if (this.stopped) return;

        if (/detached|context|navigation|not connected/i.test(error.message) && ++this.failures <= 3) return;

        this.setState('needs_attention', this.safeError(error));

      });

      await this.work; this.work = null;

      if (!terminal.has(this.state?.status)) this.watch();

    }, this.pollMs);

    this.timer.unref?.();

  }



  async acquirePhone() {

    if (this.stopped || !this.activeId || typeof this.purchasePhone !== 'function') return false;
    if (['pending', 'failed'].includes(this.phonePurchaseStatus)) return false;
    if (['provided', 'purchased'].includes(this.phonePurchaseStatus)) return !!this.phoneApproved;

    const id = this.activeId;

    this.phonePurchaseStatus = 'pending';

    this.setState('running', 'Phone form reached · purchasing one SMS number', 'phone');

    try {

      const number = await this.purchasePhone();

      const details = phoneDetails(number?.phoneNumber, undefined, this.store.get(id).country);

      this.redactions.add(number?.phoneNumber); this.redactions.add(details.phone);

      this.store.reservePhone(details, id);

      // Keep known returned numbers in history even if the provider's
      // activation metadata is invalid. An unsuccessful attempt still owns it.
      this.store.update(id, { ...details, heroSMS: null });

      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(number?.activationId || ''))) throw new Error('HeroSMS returned an invalid activation ID. The returned phone number remains reserved.');

      const heroSMS = { activationId: String(number.activationId) };
      this.redactions.add(heroSMS.activationId);

      this.store.update(id, { ...details, heroSMS });

      this.phonePurchaseStatus = 'purchased';

      if (this.stopped || id !== this.activeId) return false;

      this.phoneApproved = true;

      this.smsPoll = { activationId: heroSMS.activationId, deadline: null, nextAt: 0, finished: false, retryable: false, providerStatus: null };

      this.addLog('SMS number saved. Continuing with the phone form.');

      return true;

    } catch (error) {

      this.phonePurchaseStatus = 'failed';

      if (!this.stopped) this.setState('awaiting_phone', `Number purchase stopped: ${this.safeError(error)} Enter a phone number manually. No automatic repurchase will be made.`, 'phone');

      return false;

    }

  }

  async prepare(view, record) {

    const { frame, phase, fields } = view;

    if (phase === 'profile') {

      for (const name of ['firstName', 'lastName']) await dom.fill(frame, name, record[name]);

      const [year, month, day] = record.birthDate.split('-');

      for (const [id, value] of [['birthDay', day], ['birthMonth', month], ['birthYear', year]]) await dom.fill(frame, id, String(Number(value)));

    } else if (phase === 'email') {

      if (view.displayedEmail) {

        if (view.wrongDomain) throw new Error('GMX suggested a domain other than gmx.de. Choose a gmx.de address in Chrome, then retry.');

      } else if (!(view.aliasAvailable && view.email && (!record.requestedEmail || view.email.toLowerCase() === record.requestedEmail.toLowerCase()))) {

        if (!record.requestedEmail && await dom.chooseSuggestion(frame)) return 'navigating';

        const candidate = record.requestedEmail || record.candidateEmail;

        await dom.select(frame, 'domain', 'gmx.de'); await dom.fill(frame, 'alias', candidate.split('@')[0]);

      }

    } else if (phase === 'address') {

      if (fields.some(field => field.id === 'country')) await dom.select(frame, 'country', record.country);

      const current = await dom.read(frame);

      for (const id of ['postalCode', 'city', 'street']) if (current.fields.some(field => field.id === id)) await dom.fill(frame, id, record[id]);

      const genders = current.fields.filter(field => field.name === 'gender' && field.type === 'radio');

      if (genders.length) {

        const choices = { female: /^(female|f|woman|frau|weiblich)$/i, male: /^(male|m|man|herr|mann|männlich)$/i,

          diverse: /^(diverse|divers|other|d)$/i, unspecified: /^(unspecified|unknown|none|not_specified|no_answer|keine angabe)$/i };

        const gender = genders.find(field => choices[record.gender].test(field.choice) || choices[record.gender].test(field.label));

        if (gender) { const nodes = await dom.nodes(frame, `[id=${JSON.stringify(gender.id)}]`); try { await nodes[0].click(); } finally { await Promise.all(nodes.map(node => node.dispose())); } }

        else if (genders.some(field => field.required) && !genders.some(field => field.checked)) throw new Error('GMX requires a gender option that was not provided. Select it in Chrome, then retry.');

      }

    } else if (phase === 'password') {

      for (const id of ['password', 'confirmPassword']) if (fields.some(field => field.id === id)) await dom.fill(frame, id, record.password);

    } else if (phase === 'phone') {

      await dom.select(frame, 'mobilePhonePrefix', record.phoneCountryCode); await dom.fill(frame, 'mobilePhone', record.phone);

    } else if (phase === 'otp') {

      const inputs = fields.filter(field => /^confirmationCode\.\d+\.digit$/.test(field.id)).sort((a, b) => Number(a.id.split('.')[1]) - Number(b.id.split('.')[1]));

      if (inputs.length) {

        if (!this.pendingCode || inputs.length !== this.pendingCode.length) {

          this.pendingCode = null; this.otpReady = false;

          this.setState('awaiting_otp', `GMX requires a ${inputs.length}-digit verification code. Enter it in the dashboard.`, 'otp');

          return false;

        }

        for (let i = 0; i < inputs.length; i++) await dom.fill(frame, inputs[i].id, this.pendingCode[i]);

      } else await dom.fill(frame, 'verificationCode', this.pendingCode);

      this.pendingCode = null; this.otpReady = true;

      this.addLog(inputs.length ? `Filled all ${inputs.length} SMS code digits in GMX.` : 'Filled the SMS verification code field in GMX.');

    }

  }

  async handleCaptcha(view, message) {

    if (this.manualCaptcha?.frame === view.frame && this.manualCaptcha.key === view.key) {

      this.setState('awaiting_captcha', message, view.phase);

      return;

    }

    this.addLog(`CAPTCHA detected on ${view.phase} step.`);

    if (this.solver) {

      this.setState('running', 'Solving CAPTCHA automatically · falls back to manual if needed', view.phase);

      this.addLog('Attempting to solve CAPTCHA automatically...');

      const solved = await this.solver.trySolve(view.frame).catch((err) => {

        if (!this.stopped) this.addLog(`Solver crashed: ${this.safeError(err)}`);

        return false;

      });

      if (this.stopped) return;

      if (solved) { 

        this.addLog('✅ CAPTCHA solved automatically! Continuing...');

        this.unknownSince = null; this.failures = 0; return; 

      } else {

        this.addLog('❌ Solver failed or timed out. Falling back to manual solving.');

      }

    } else {

      this.addLog('No solver configured. Waiting for manual CAPTCHA solve in Chrome.');

    }

    this.manualCaptcha = { frame: view.frame, key: view.key };

    this.setState('awaiting_captcha', message, view.phase);

  }



  async failRegistrationHelp(page = this.page) {
    if (!this.state || terminal.has(this.state.status)) return;
    if (page) this.page = page;
    const phase = this.submitted?.phase || this.state.phase || 'unknown';
    const visible = this.lastVisibleError?.phase === phase && Date.now() - this.lastVisibleError.time <= 30_000 ? this.lastVisibleError.message : null;
    const issue = this.lastRequestIssue?.phase === phase && Date.now() - this.lastRequestIssue.time <= 30_000 ? this.lastRequestIssue : null;
    const reason = `GMX redirected to registration help. ${visible ? `Last visible GMX error: ${visible}` : 'GMX did not provide a specific rejection reason.'}${issue ? ` Last observed GMX request: ${issue.method} ${issue.code}.` : ''} Attempt stopped for review.`;
    this.recordFailure('GMX_REGISTRATION_HELP', reason, { phase });
    this.stopped = true; clearTimeout(this.timer); this.timer = null;
    this.smsController?.abort(new Error('GMX redirected to registration help.'));
    // This may run inside tick(); waiting for this.work here would deadlock.
    await this.releaseBrowser();
  }

  finishRegistration(view) {
    const mailboxUrl = view.page?.url();
    if (!view.mailboxRedirect || !isMailboxUrl(mailboxUrl)) throw new Error('A verified GMX Navigator mailbox redirect is required before marking success.');
    const email = /@gmx\.de$/i.test(view.email || '') ? view.email : null;
    const verification = { completionSource: 'mailbox_redirect', completionOrigin: new URL(mailboxUrl).origin, failureCode: null, failurePhase: null };
    this.store.update(this.activeId, { completedAt: Date.now(), ...verification, ...(email ? { email } : {}) });
    this.state = { ...this.state, ...verification };
    if (email) this.state = { ...this.state, emailHint: emailHint(email) };
    this.setState('complete', 'Verified GMX Navigator mailbox redirect · account creation complete', 'confirmation');
  }

  async handleSmsTimeout(poll) {
    if (this.stopped || this.smsPoll !== poll || !this.browser?.connected || this.pendingCode || this.otpReady) return;
    poll.finished = true; poll.retryable = true;
    if (!this.smsResendAttempted) {
      let buttons = [];
      try {
        const view = await dom.scan(this.browser);
        if (this.stopped || this.smsPoll !== poll || this.pendingCode || this.otpReady) return;
        if (view?.registrationHelp) { await this.failRegistrationHelp(view.page); return; }
        if (view?.success) { this.finishRegistration(view); return; }
        if (view?.phase === 'otp' && !view.captcha) {
          buttons = await dom.nodes(view.frame, 'button[data-testid="resend-code-button"]');
          for (const button of buttons) {
            if (!await button.evaluate(el => !el.disabled && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' && el.getAttribute('aria-busy') !== 'true')) continue;
            if (this.stopped || this.smsPoll !== poll || this.pendingCode || this.otpReady || this.smsController?.signal.aborted) return;
            // Mark before clicking: a lost response must never replay an SMS
            // request. The number and HeroSMS activation remain unchanged.
            this.smsResendAttempted = true;
            await button.click();
            if (this.stopped || this.smsPoll !== poll || this.pendingCode || this.otpReady) return;
            Object.assign(poll, { deadline: Date.now() + this.smsTimeoutMs, nextAt: 0, finished: false, retryable: false, providerStatus: null });
            this.addLog('Requested one SMS resend in GMX · checking the same HeroSMS activation again.');
            this.setState('awaiting_otp', 'SMS code requested again · waiting for the same number', 'otp');
            return;
          }
        }
      } catch {
        if (this.stopped || this.pendingCode || this.otpReady) return;
        this.addLog(this.smsResendAttempted ? 'The SMS resend click could not be confirmed. It will not be repeated automatically.' : 'The SMS resend button could not be checked. Manual entry remains available.');
      } finally { await Promise.all(buttons.map(button => button.dispose().catch(() => {}))); }
    }
    this.setState('awaiting_otp', 'HeroSMS code wait timed out · click Check SMS again or enter the code manually', 'otp');
  }

  async pollSms() {

    const poll = this.smsPoll;

    if (!poll || poll.finished) {

      if (this.state.status !== 'awaiting_otp') this.setState('awaiting_otp', 'Enter the SMS code you received in the dashboard', 'otp');

      return;

    }

    poll.deadline ??= Date.now() + this.smsTimeoutMs;

    if (Date.now() >= poll.deadline) {

      await this.handleSmsTimeout(poll);

      return;

    }

    this.setState('awaiting_otp', 'Waiting for HeroSMS verification code · checking automatically; manual entry is available', 'otp');

    if (Date.now() < poll.nextAt) return;

    poll.nextAt = Date.now() + this.smsPollMs;

    const { signal } = this.smsController;

    try {

      if (!poll.providerStatus) this.addLog('Checking HeroSMS for the SMS verification code...');

      const sms = await this.smsClient(poll.activationId, {

        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, poll.deadline - Date.now()))]),

      });

      if (this.stopped || signal.aborted || !this.browser?.connected || this.smsPoll !== poll || this.state.status !== 'awaiting_otp' || this.pendingCode || this.otpReady) return;

      if (Date.now() >= poll.deadline && sms?.status !== 'RECEIVED') {

        await this.handleSmsTimeout(poll);

        return;

      }

      if (sms?.status === 'WAITING') {

        const prefix = typeof sms.rawStatus === 'string' ? sms.rawStatus.split(':')[0] : '';

        const status = ['STATUS_WAIT_CODE', 'STATUS_WAIT_RETRY', 'STATUS_WAIT_RESEND'].includes(prefix) ? prefix : 'WAITING';

        if (poll.providerStatus !== status) this.addLog(`HeroSMS response: ${status} · no SMS code received yet; checking every ${this.smsPollMs / 1000} seconds.`);

        poll.providerStatus = status;

        return;

      }

      poll.finished = true;

      if (sms?.status === 'RECEIVED' && typeof sms.otp === 'string' && /^\d{4,10}$/.test(sms.otp.trim())) {

        this.addLog('HeroSMS verification code received · preparing to fill GMX.');



        await this.submitOtp({ code: sms.otp });

      } else {

        this.setState('awaiting_otp', sms?.status === 'CANCELLED'

          ? 'HeroSMS activation was cancelled · enter the code manually or review the phone number in Chrome'

          : 'HeroSMS did not return a valid verification code · enter it manually in the dashboard', 'otp');

      }

    } catch {

      if (this.stopped || signal.aborted) return;

      if (Date.now() >= poll.deadline) { await this.handleSmsTimeout(poll); return; }

      poll.finished = true; poll.retryable = true;

      this.setState('awaiting_otp', 'Could not retrieve the HeroSMS code · click Check SMS again or enter it manually', 'otp');

    }

  }

  async tick() {

    if (this.stopped || !this.state || terminal.has(this.state.status)) return;

    if (!this.browser?.connected) { this.setState('paused', 'Registration browser closed · encrypted details saved'); return; }

    const view = await dom.scan(this.browser);

    if (this.stopped) return;

    if (!view) return this.waitUnknown('Waiting for the GMX registration page');

    if (view.registrationHelp) { await this.failRegistrationHelp(view.page); return; }

    if (!view.captcha) this.manualCaptcha = null;

    this.page = view.page;

    if (view.errors?.length) this.lastVisibleError = { phase: view.phase, message: this.safeError(view.errors[0]).slice(0, 600), time: Date.now() };

    if (view.email) {

      const record = this.store.get(this.activeId);

      if (record.email !== view.email) { this.store.update(this.activeId, { email: view.email }); this.state = { ...this.state, emailHint: emailHint(view.email) }; this.publish(); }

    }

    if (view.success) { this.finishRegistration(view); return; }

    if (view.summaryPage) {
      if (view.errors.length) { this.setState('needs_attention', `GMX needs attention: ${this.safeError(view.errors[0])} · waiting for the GMX Navigator mailbox redirect`, 'confirmation'); return; }
      if (!view.next) { this.setState('running', 'Waiting for the verified GMX Navigator mailbox redirect', 'confirmation'); return; }
    }

    if (view.key !== this.currentKey) {

      this.currentKey = view.key; this.unknownSince = null;

      if (this.state.status === 'needs_attention' && this.attentionKey && view.key !== this.attentionKey && view.phase !== 'unknown') {

        this.setState('running', 'GMX advanced · continuing with the current form', view.phase);

      }

    }

    if (this.state.status === 'needs_attention') return;

    if (view.phase === 'unknown') {

      if (view.captcha) { await this.handleCaptcha(view, 'Solve CAPTCHA in Chrome · automation resumes when it clears'); return; }

      this.waitUnknown('Waiting for the next recognized GMX form'); return;

    }

    if (this.submitted && this.submitted.key !== view.key) { this.submitted = null; this.prepared = null; this.unknownSince = null; }

    if (this.submitted?.key === view.key) {

      if (view.captcha) { this.submitted.at = Date.now(); await this.handleCaptcha(view, 'Solve CAPTCHA in Chrome · waiting for GMX to continue'); return; }

      if (view.errors.length || Date.now() - this.submitted.at > this.transitionMs) this.setState('needs_attention', view.errors.length ? `GMX needs attention: ${this.safeError(view.errors[0])}` : 'GMX has not advanced · review Chrome and retry. The submitted form was not repeated.', view.phase);

      return;

    }

    if (view.captcha && (view.phase === 'phone' && !this.phoneApproved || view.phase === 'otp' && !this.pendingCode && !this.otpReady)) {

      await this.handleCaptcha(view, 'Solve CAPTCHA in Chrome · automation resumes when it clears'); return;

    }

    if (view.phase === 'phone' && !this.phoneApproved) {

      if (this.purchasePhone && this.phonePurchaseStatus === 'idle') {

        if (!await this.acquirePhone()) return;

      } else {

        if (this.phonePurchaseStatus !== 'failed') this.setState('awaiting_phone', 'Enter your own phone number in the dashboard, or complete the phone form in Chrome', 'phone');

        return;

      }

    }

    if (view.phase === 'otp' && !this.pendingCode && !this.otpReady) { await this.pollSms(); return; }

    if (this.prepared !== view.key) {

      this.setState('running', `Filling GMX ${view.phase} fields`, view.phase);

      const result = await this.prepare(view, this.store.get(this.activeId));

      if (this.stopped) return;

      if (result === false) return;

      this.prepared = view.key; this.failures = 0;

      if (result === 'navigating') { this.submitted = { key: view.key, phase: view.phase, at: Date.now() }; return; }

    }

    const fresh = await dom.read(view.frame);

    if (this.stopped) return;

    if (dom.phaseOf(fresh) !== view.phase) return;

    if (fresh.captcha) { await this.handleCaptcha(view, 'Solve CAPTCHA in Chrome · automation resumes when it clears'); return; }

    if (view.phase === 'email' && fresh.wrongDomain) throw new Error('Only gmx.de addresses are supported. Select a gmx.de address in Chrome.');

    const invalid = fresh.fields.find(field => field.required && !field.disabled && !field.valid);

    if (invalid) { this.setState('needs_attention', `GMX requires a valid ${this.safeError(invalid.label || invalid.id)} field. Review the dashboard details or correct it in Chrome.`, view.phase); return; }

    if (fresh.nextDisabled) return this.waitUnknown('Waiting for GMX to enable Continue');

    this.submitted = { key: view.key, phase: view.phase, at: Date.now() }; this.unknownSince = null;

    this.setState('running', `Submitting GMX ${view.phase} step`, view.phase);

    if (!await dom.next(view.frame)) this.submitted = null;

    else if (view.phase === 'phone') this.phoneApproved = false;

    else if (view.phase === 'otp') this.otpReady = false;

  }

  waitUnknown(message) { this.unknownSince ||= Date.now(); if (Date.now() - this.unknownSince > this.transitionMs) this.setState('needs_attention', `${message} · inspect Chrome, then retry`); }

  async inspectNextStep() {

    if (!this.browser?.connected) throw new Error('The GMX registration browser is no longer open.');

    if (this.state.status === 'awaiting_otp' && this.smsPoll?.finished && this.smsPoll.retryable) {

      this.smsController?.abort();

      this.smsController = new AbortController();



      this.smsPoll = { ...this.smsPoll, deadline: null, nextAt: 0, finished: false, retryable: false, providerStatus: null };

      this.setState('awaiting_otp', 'Rechecking HeroSMS for the same phone number', 'otp');

      this.watch(); return this.snapshot();

    }

    if (this.submitted && this.state.phase === 'phone') this.phoneApproved = false;

    if (this.submitted && this.state.phase === 'otp') { this.pendingCode = null; this.otpReady = false; }

    this.prepared = null; this.submitted = null; this.failures = 0; this.unknownSince = null;

    this.setState('running', 'Rechecking the current GMX form'); this.watch(); return this.snapshot();

  }

  async submitPhone({ phone, countryCode }) {

    if (this.state?.status !== 'awaiting_phone') throw new Error('GMX is not waiting for a phone number.');

    const details = phoneDetails(phone, countryCode);
    this.store.reservePhone(details, this.activeId);
    this.store.update(this.activeId, { ...details, heroSMS: null }); this.phoneApproved = true; this.prepared = null;

    this.smsPoll = null; this.smsController?.abort();

    this.setState('running', 'Phone received · filling GMX and requesting one SMS code', 'phone'); this.watch(); return this.snapshot();

  }

  async submitOtp({ code }) {

    if (this.state?.status !== 'awaiting_otp') throw new Error('GMX is not waiting for a verification code.');

    if (typeof code !== 'string' || !/^\d{4,10}$/.test(code.trim())) throw new Error('Enter the numeric SMS verification code.');

    if (this.smsPoll) { this.smsPoll.finished = true; this.smsPoll.retryable = false; }

    this.smsController?.abort();

    this.pendingCode = code.trim(); this.redactions.add(this.pendingCode); this.prepared = null;

    this.setState('running', 'Verification code received · submitting it to GMX', 'otp'); this.watch(); return this.snapshot();

  }

  reveal(id) { const record = this.store.get(id); if (!record) throw new Error('Registration record not found.'); return { email: record.email || record.candidateEmail, password: record.password }; }

  failureImage(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    const kind = this.store.get(id)?.failureImage?.kind;
    if (!['screenshot', 'diagnostic'].includes(kind)) return null;
    const filename = path.join(path.dirname(this.store.dbPath), 'registration-failures', id, kind === 'screenshot' ? 'failure.png' : 'failure.svg');
    try { const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink()) return null; } catch { return null; }
    return { path: filename, kind };
  }

  async saveFailureImage(browser = this.browser, page = this.page) {
    if (!this.activeId || this.state?.status === 'complete') return null;
    if (this.failureCapture) return this.failureCapture;
    const id = this.activeId;
    this.failureCapture = (async () => {
      try {
        const record = this.store.get(id);
        const secrets = [record?.password, record?.phone, record?.phone && `${record.phoneCountryCode}${record.phone}`,
          record?.heroSMS?.activationId, this.maskifyEnv?.ANYSOLVER_API_KEY, this.maskifyEnv?.HEROSMS_API_KEY,
          ...(this.redactions || []), ...[record?.firstName, record?.lastName, record?.street, record?.birthDate].filter(value => value?.length >= 4)];
        if (page && !page.isClosed()) await page.waitForFunction(() => document.readyState !== 'loading' && document.body, { timeout: 2000 }).catch(() => {});
        const artifact = await captureFailure(browser, path.join(path.dirname(this.store.dbPath), 'registration-failures', id, 'failure.png'), {
          message: this.safeError(this.state?.stage || 'Registration stopped before success.'),
          stage: `Registration ${this.state?.failurePhase || this.state?.phase || 'startup'} · ${this.state?.failureCode || 'STOPPED'}`,
          secrets, preferredPage: page, redactPhones: true, redactUrlQueries: true,
        });
        this.store.update(id, { failureImage: { kind: artifact.kind, savedAt: Date.now() } });
        this.state = { ...this.state, failureImageUrl: `/api/registration/${id}/failure-image`, failureArtifactKind: artifact.kind };
        this.addLog(`${artifact.kind === 'screenshot' ? 'Failure screenshot' : 'Failure diagnostic image'} saved: ${path.relative(PROJECT_ROOT, artifact.path)}`);
        return artifact;
      } catch {
        this.state = { ...this.state, failureImageError: 'Could not save the failure image. Check disk space and directory permissions.' };
        this.addLog(`[ERROR] ${this.state.failureImageError}`);
        return null;
      }
    })();
    return this.failureCapture;
  }

  tableRecords() {

    return this.store.db.prepare('SELECT id FROM registrations ORDER BY created_at DESC, id DESC').all().map(({ id }) => {

      const record = this.store.get(id);

      return { id, email: record.email || record.candidateEmail, firstName: record.firstName, lastName: record.lastName,

        birthDate: record.birthDate, gender: record.gender, phone: record.phone ? `${record.phoneCountryCode}${record.phone}` : '',

        street: record.street, postalCode: record.postalCode, city: record.city, country: record.country,

        status: ['complete', 'user_confirmed'].includes(record.status) && !isVerifiedRegistration(record) ? 'unverified' : record.status, createdAt: record.created_at, updatedAt: record.updated_at,

        eligible: isVerifiedRegistration(record) && !!record.email,
        failureImageUrl: ['screenshot', 'diagnostic'].includes(record.failureImage?.kind) ? `/api/registration/${id}/failure-image` : null,
        failureArtifactKind: record.failureImage?.kind || null };

    });

  }

  accountsForBatch(ids) {

    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length) {

      throw new Error('Select 1–500 different saved registrations.');

    }

    const accounts = ids.map(id => {

      const record = this.store.get(id);

      if (!isVerifiedRegistration(record) || !/^[^\s@]+@gmx\.de$/i.test(record.email || '') || !record.password) {

        throw new Error('Only registrations with a verified GMX Navigator mailbox redirect and saved GMX credentials can run IMAP / POP3.');

      }

      return { email: record.email, password: record.password };

    });

    if (new Set(accounts.map(account => account.email.toLowerCase())).size !== accounts.length) throw new Error('The selection contains duplicate email addresses.');

    return accounts;

  }

  async closeBrowser() {

    this.stopped = true; clearTimeout(this.timer); this.timer = null; this.smsController?.abort(); await this.work;

    this.smsPoll = null;

    await this.releaseBrowser();

  }

  async releaseBrowser() {

    if (this.browserCleanup) return this.browserCleanup;

    const browser = this.browser, page = this.page; this.browser = null; this.page = null; this.pendingCode = null;

    const solver = this.solver;
    const cleanup = this.browserCleanup = (async () => {
      if (this.state?.status !== 'complete') await this.saveFailureImage(browser, page);
      await browser?.close().catch(() => {});
      await solver?.closeProxy().catch(() => {});
    })();
    try { await cleanup; }
    finally { if (this.browserCleanup === cleanup) this.browserCleanup = null; }

  }

  async close() { await this.closeBrowser(); if (this.ownsStore) this.store.close(); }

}



function createRegistrationRouter(registrationAssistant = null, { generateProfile: makeProfile = generateProfile, batch = null } = {}) {

  const router = Router();

  const snapshot = () => ({ ...(registrationAssistant?.snapshot() || { active: null, records: [] }), ...(batch ? batch.snapshot() : {}) });
  const sessionFor = id => batch?.session(id) || (registrationAssistant?.activeId === id ? registrationAssistant : null);
  router.get('/state', (_req, res) => res.json(snapshot()));

  const sendFailureImage = (req, res, artifact) => {
    if (!artifact) return res.sendStatus(404);
    if (req.query.download === '1') res.attachment(`registration-${req.params.id}-failure${path.extname(artifact.path)}`);
    res.sendFile(artifact.path);
  };
  router.get('/failures/:id/image', (req, res) => sendFailureImage(req, res, batch?.failureImage?.(req.params.id)));
  router.get('/:id/failure-image', (req, res) => sendFailureImage(req, res, registrationAssistant?.failureImage?.(req.params.id)));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 3, parts: 4, fieldSize: 100 } });
  router.post('/batches', (req, res, next) => {
    if (!batch) return res.status(503).json({ error: 'Registration batches are unavailable.' });
    if (batch.run?.active || registrationAssistant.starting || registrationAssistant.browser?.connected) return res.status(409).json({ error: 'Finish or close the active registration before starting a batch.' });
    next();
  }, upload.single('proxies'), async (req, res) => {
    try {
      if (req.file && !/\.txt$/i.test(req.file.originalname)) throw new Error('Choose a proxy TXT file.');
      if (req.body.connectionMode === 'proxy' && !req.file) throw new Error('Choose a proxy TXT file.');
      const result = await batch.start({ ...req.body, proxyText: req.file?.buffer.toString('utf8') });
      res.status(202).json({ ...registrationAssistant.snapshot(), ...result });
    } catch (error) { res.status(400).json({ error: error.message }); }
    finally { req.file?.buffer.fill(0); }
  });
  router.post('/batches/:id/stop', (req, res) => {
    if (!batch || batch.run?.id !== req.params.id) return res.status(404).json({ error: 'Registration batch not found.' });
    batch.stop(); res.json(snapshot());
  });
  router.post('/batches/:id/export', (req, res) => {
    if (!batch) return res.status(503).json({ error: 'Registration batches are unavailable.' });
    try {
      const output = batch.export(req.params.id);
      res.attachment(`gmx-accounts-${req.params.id}.txt`).type('text/plain').send(output);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.post('/records', (_req, res) => {

    if (!registrationAssistant?.tableRecords) return res.json({ records: [] });

    try { res.json({ records: registrationAssistant.tableRecords() }); }

    catch { res.status(500).json({ error: 'Saved registrations could not be loaded.' }); }

  });

  router.post("/", async (req, res) => {

    if (!registrationAssistant) return res.status(503).json({ error: "Registration assistance is unavailable in this server instance." });
    if (batch?.run?.active) return res.status(409).json({ error: 'A registration batch is already running.' });

    try {

      const connection = req.body?.connectionMode === undefined ? { mode: 'maskify' }

        : { mode: req.body.connectionMode, proxyText: req.body.proxyText };

      registrationConnection(connection);

      const person = await makeProfile();

      if (batch?.run?.active) return res.status(409).json({ error: 'A registration batch is already running.' });

      res.status(202).json(await registrationAssistant.start(person, connection));

    }

    catch (error) { res.status(400).json({ error: error.message }); }

  });

  router.post("/:id/inspect-next", async (req, res) => {

    const assistant = sessionFor(req.params.id);
    if (!assistant) return res.status(404).json({ error: "Registration session not found." });

    try { await assistant.inspectNextStep(); res.json(snapshot()); }

    catch (error) { res.status(400).json({ error: error.message }); }

  });

  router.post("/:id/phone", async (req, res) => {

    const assistant = sessionFor(req.params.id);
    if (!assistant) return res.status(404).json({ error: "Registration session not found." });

    try { await assistant.submitPhone(req.body || {}); res.json(snapshot()); }

    catch (error) { res.status(400).json({ error: error.message }); }

  });

  router.post("/:id/otp", async (req, res) => {

    const assistant = sessionFor(req.params.id);
    if (!assistant) return res.status(404).json({ error: "Registration session not found." });

    try { await assistant.submitOtp(req.body || {}); res.json(snapshot()); }

    catch (error) { res.status(400).json({ error: error.message }); }

  });

  router.post("/:id/credentials", (req, res) => {

    if (!registrationAssistant) return res.status(503).json({ error: "Registration assistance is unavailable in this server instance." });

    try { res.json(registrationAssistant.reveal(req.params.id)); }

    catch (error) { res.status(404).json({ error: error.message }); }

  });

  router.post("/:id/close", async (req, res) => {

    const assistant = sessionFor(req.params.id);
    if (!assistant) return res.status(404).json({ error: "Registration session not found." });
    await assistant.closeBrowser();
    if (!["complete", "failed", "cancelled"].includes(assistant.state?.status)) assistant.setState("paused", "Browser closed · encrypted profile saved");
    res.json(snapshot());

  });

  return router;

}



module.exports = { RegistrationAssistant, createRegistrationRouter, validateProfile, phoneDetails, FIRST_STEP, RegistrationStore, emailHint };
