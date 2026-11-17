const puppeteer = require('puppeteer');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

function launchRegistrationBrowser(options) {
  // Plugins keep launch/profile state. Give each browser its own instances so
  // disconnecting one worker cannot clean up another worker's profile.
  const driver = addExtra(puppeteer);
  driver.use(StealthPlugin());
  return driver.launch(options);
}

function describeBrowserLaunch(browser) {
  const args = browser.process?.()?.spawnargs;
  const available = Array.isArray(args);
  const counts = new Map();
  for (const arg of available ? args : []) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
    const name = arg.split('=', 1)[0];
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  // Never include argument values: proxy credentials, URLs and profile paths
  // can contain secrets or private information.
  return {
    available,
    switches: [...counts.keys()],
    repeatedSwitches: [...counts].filter(([, count]) => count > 1).map(([name]) => name),
    profileArgumentPresent: available ? counts.has('--user-data-dir') : null,
  };
}

module.exports = { launchRegistrationBrowser, describeBrowserLaunch };
