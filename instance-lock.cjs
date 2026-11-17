const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function acquireInstanceLock(directory) {
  // A separate SQLite write lock works across processes on Windows and Linux.
  // The OS releases it after a crash; it never locks the account database itself.
  const filename = path.join(directory, 'registration.instance.sqlite');
  const lock = new DatabaseSync(filename);
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    fs.chmodSync(filename, 0o600);
    return lock;
  } catch (error) {
    lock.close();
    if (error.errcode === 5 || /locked|busy/i.test(error.message)) {
      throw Object.assign(new Error('GMX is already running with this data directory. Close the existing instance first.'), { code: 'APP_ALREADY_RUNNING' });
    }
    throw error;
  }
}

module.exports = { acquireInstanceLock };
