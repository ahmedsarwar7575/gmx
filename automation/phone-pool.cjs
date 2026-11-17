const { createHmac } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { abortable } = require('../async-control.cjs');

const PHONE_TTL_MS = 20 * 60_000;
const MAX_PHONE_USES = 1;
const MIN_PHONE_REMAINING_MS = 2 * 60_000;

function sharedProviderFailure(error) {
  const code = error?.providerCode || error?.code || error?.cause?.code;
  return ['BAD_KEY', 'ACCESS_DENIED', 'BANNED', 'NO_BALANCE', 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS',
    'PAYMENT_REQUIRED', 'HEROSMS_PAYMENT_REQUIRED', 'BAD_SERVICE', 'BAD_COUNTRY', 'BAD_ACTION',
    'NETWORK_ERROR', 'TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
    'EHOSTUNREACH', 'ENETUNREACH', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'SMS_PROVIDER_UNAVAILABLE'].includes(code)
    || /^(?:HTTP_)?(?:401|402|403|429|5\d\d)$/.test(String(error?.httpStatus || code || ''))
    || error?.name === 'TimeoutError';
}

function timestamp(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const text = String(value).replace(' ', 'T');
  const parsed = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

class PhoneNumberPool {
  constructor({ store, purchasePhone, requestNextSms, checkProvider, now = Date.now,
    minRemainingMs = MIN_PHONE_REMAINING_MS, cooldownMs = 60_000, wait = sleep } = {}) {
    if (!Number.isFinite(minRemainingMs) || minRemainingMs < 0 || minRemainingMs >= PHONE_TTL_MS) throw new Error('SMS minimum remaining lifetime must be between 0 and 20 minutes.');
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) throw new Error('SMS provider cooldown must be positive.');
    Object.assign(this, { store, purchasePhone, requestNextSms, checkProvider, now, minRemainingMs, cooldownMs, wait, outage: null, probe: null });
  }

  pause(error) {
    this.outage = { code: error?.providerCode || error?.code || 'SMS_PROVIDER_UNAVAILABLE', retryAt: this.now() + this.cooldownMs };
  }

  providerStatus() { return { paused: !!this.outage, retryAt: this.outage?.retryAt || null,
    code: this.outage?.code || null, minRemainingMs: this.minRemainingMs }; }

  async waitForProvider({ signal, onPause } = {}) {
    while (this.outage) {
      signal?.throwIfAborted();
      onPause?.(this.providerStatus());
      await abortable(() => this.wait(Math.max(0, this.outage.retryAt - this.now()), undefined, { signal }), { signal });
      signal?.throwIfAborted();
      if (!this.outage) break;
      if (this.now() < this.outage.retryAt) continue;
      if (!this.probe) {
        this.probe = Promise.resolve().then(async () => {
          try {
            if (!this.checkProvider) throw Object.assign(new Error('Provider health check is unavailable.'), { code: 'SMS_PROVIDER_UNAVAILABLE' });
            await abortable(() => this.checkProvider({ signal }), { signal });
            signal?.throwIfAborted();
            this.outage = null;
          } catch (error) { if (!signal?.aborted) this.pause(error); }
        }).finally(() => { this.probe = null; });
      }
      await abortable(() => this.probe, { signal });
    }
  }

  expire() {
    this.store.db.prepare("UPDATE registration_phone_pool SET uses=?,leased_to=NULL,retired_reason='expired' WHERE expires_at<=? AND retired_reason IS NULL").run(MAX_PHONE_USES, this.now());
  }

  transaction(work) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }

  lease(row) {
    return { fingerprint: row.fingerprint, number: this.store.open(row.secret), uses: row.uses, expiresAt: row.expires_at };
  }

  claimAvailable(id) {
    return this.transaction(() => {
      this.expire();
      const row = this.store.db.prepare('SELECT * FROM registration_phone_pool WHERE uses<? AND leased_to IS NULL AND retired_reason IS NULL AND expires_at>=? ORDER BY expires_at,fingerprint LIMIT 1').get(MAX_PHONE_USES, this.now() + this.minRemainingMs);
      if (!row) return null;
      this.store.db.prepare('UPDATE registration_phone_pool SET uses=uses+1,leased_to=? WHERE fingerprint=?').run(id, row.fingerprint);
      return this.lease({ ...row, uses: row.uses + 1 });
    });
  }

  addPurchased(number, id, requestedAt = this.now()) {
    const fingerprint = this.store.phoneFingerprint({ phone: number?.phoneNumber, country: 'Germany' });
    const now = this.now(), acquiredAt = Math.min(requestedAt, timestamp(number.activationTime) ?? requestedAt);
    const expiresAt = Math.min(acquiredAt + PHONE_TTL_MS, timestamp(number.activationEndTime) ?? Infinity);
    const valid = /^[A-Za-z0-9_-]{1,128}$/.test(String(number.activationId || ''));
    const reason = !valid ? 'invalid activation' : expiresAt <= now ? 'expired' : expiresAt - now < this.minRemainingMs ? 'insufficient remaining time' : null;
    const row = this.transaction(() => {
      if (this.store.db.prepare('SELECT fingerprint FROM registration_phone_numbers WHERE fingerprint=?').get(fingerprint)) {
        throw Object.assign(new Error('HeroSMS returned a previously tracked phone number. It will not be reused.'), { code: 'PHONE_REUSED' });
      }
      this.store.db.prepare('INSERT INTO registration_phone_numbers VALUES (?,?,?)').run(fingerprint, id, now);
      const secret = this.store.seal({ ...number, codeHashes: [] });
      this.store.db.prepare('INSERT INTO registration_phone_pool VALUES (?,?,?,?,?,?,?,?)')
        .run(fingerprint, secret, acquiredAt, expiresAt, reason ? MAX_PHONE_USES : 1, reason ? null : id, reason, now);
      return { fingerprint, secret, uses: reason ? MAX_PHONE_USES : 1, expires_at: expiresAt };
    });
    if (reason) throw Object.assign(new Error(`HeroSMS number cannot be used (${reason}). It was retired at ${MAX_PHONE_USES}/${MAX_PHONE_USES}.`), {
      code: reason === 'expired' ? 'PHONE_EXPIRED' : reason === 'insufficient remaining time' ? 'PHONE_LIFETIME_TOO_SHORT' : 'PHONE_ACTIVATION_INVALID' });
    return this.lease(row);
  }

  async acquire(id, { signal, onPause } = {}) {
    signal?.throwIfAborted();
    await this.waitForProvider({ signal, onPause });
    let lease;
    while ((lease = this.claimAvailable(id))) {
      try {
        await abortable(() => this.requestNextSms(lease.number.activationId, { signal }), { signal });
        signal?.throwIfAborted();
        this.assertActive(id);
        if (lease.expiresAt - this.now() < this.minRemainingMs) { this.retire(id, 'insufficient remaining time'); continue; }
        return lease;
      } catch (error) {
        this.retire(id, 'SMS reset failed');
        signal?.throwIfAborted();
        if (sharedProviderFailure(error)) { this.pause(error); await this.waitForProvider({ signal, onPause }); }
      }
    }
    await this.waitForProvider({ signal, onPause });
    signal?.throwIfAborted();
    const requestedAt = this.now();
    const reconcile = number => { this.addPurchased(number, id, requestedAt); this.retire(id, 'cancelled during purchase'); };
    let number;
    try { number = await abortable(() => this.purchasePhone({ signal }), { signal, onLateResult: reconcile }); }
    catch (error) { if (!signal?.aborted && sharedProviderFailure(error)) this.pause(error); throw error; }
    lease = this.addPurchased(number, id, requestedAt);
    if (signal?.aborted) { this.retire(id, 'cancelled during purchase'); signal.throwIfAborted(); }
    return lease;
  }

  assertActive(id) {
    const row = this.store.db.prepare('SELECT * FROM registration_phone_pool WHERE leased_to=?').get(id);
    if (!row || row.expires_at <= this.now() || row.retired_reason) {
      this.retire(id, 'expired');
      throw Object.assign(new Error('The SMS number expired or was retired. This attempt requires a different number.'), { code: 'PHONE_EXPIRED' });
    }
    return row;
  }

  codeHash(code) { return createHmac('sha256', this.store.key).update(`sms-code\0${code.trim()}`).digest('hex'); }

  isPreviousCode(id, code) {
    const row = this.assertActive(id);
    return this.store.open(row.secret).codeHashes.includes(this.codeHash(code));
  }

  rememberCode(id, code) {
    const row = this.assertActive(id), number = this.store.open(row.secret);
    number.codeHashes = [...new Set([...number.codeHashes, this.codeHash(code)])];
    this.store.db.prepare('UPDATE registration_phone_pool SET secret=? WHERE fingerprint=?').run(this.store.seal(number), row.fingerprint);
  }

  finish(id) {
    const row = this.store.db.prepare('SELECT * FROM registration_phone_pool WHERE leased_to=?').get(id);
    if (!row) return null;
    const number = this.store.open(row.secret);
    const reason = row.expires_at <= this.now() ? 'expired' : number.canGetAnotherSms === false ? 'provider disallows reuse' : row.uses >= MAX_PHONE_USES ? 'limit reached' : null;
    const uses = reason ? MAX_PHONE_USES : row.uses;
    this.store.db.prepare('UPDATE registration_phone_pool SET uses=?,leased_to=NULL,retired_reason=? WHERE fingerprint=?').run(uses, reason, row.fingerprint);
    return { uses, expiresAt: row.expires_at, reason };
  }

  retire(id, reason = 'registration failed') {
    const row = this.store.db.prepare('SELECT * FROM registration_phone_pool WHERE leased_to=?').get(id);
    if (!row) return null;
    this.store.db.prepare('UPDATE registration_phone_pool SET uses=?,leased_to=NULL,retired_reason=? WHERE fingerprint=?').run(MAX_PHONE_USES, reason, row.fingerprint);
    return { uses: MAX_PHONE_USES, expiresAt: row.expires_at, reason };
  }

  snapshot() {
    this.expire();
    return this.store.db.prepare('SELECT * FROM registration_phone_pool ORDER BY created_at DESC LIMIT 100').all().map(row => {
      const number = this.store.open(row.secret);
      return { id: row.fingerprint, phoneHint: `+49•••${String(number.phoneNumber).slice(-4)}`,
        uses: row.uses, maxUses: MAX_PHONE_USES, expiresAt: row.expires_at,
        status: row.retired_reason || (row.leased_to ? 'in use' : row.expires_at - this.now() < this.minRemainingMs ? 'too close to expiry' : 'available') };
    });
  }
}

module.exports = { PhoneNumberPool, PHONE_TTL_MS, MAX_PHONE_USES, MIN_PHONE_REMAINING_MS, sharedProviderFailure };