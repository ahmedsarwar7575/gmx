const puppeteer = require('puppeteer');
const { addExtra } = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserPreferencesPlugin = require('puppeteer-extra-plugin-user-preferences');

const preferences = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  autofill: { profile_enabled: false, credit_card_enabled: false },
  webrtc: { ip_handling_policy: 'disable_non_proxied_udp' },
  profile: {
    default_content_setting_values: {
      geolocation: 2,
      media_stream_camera: 2,
      media_stream_mic: 2,
      notifications: 2,
    },
  },
};

function launchRegistrationBrowser(options = {}) {
  const driver = addExtra(puppeteer);
  driver.use(StealthPlugin());
  driver.use(UserPreferencesPlugin({ userPrefs: preferences }));
  const pipe = options.pipe !== undefined ? options.pipe : true;
  const ignoreDefaultArgs = options.ignoreDefaultArgs === true
    ? true
    : Array.from(new Set([...(options.ignoreDefaultArgs || []), '--enable-automation']));
  return driver.launch({ ...options, pipe, ignoreDefaultArgs });
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
  return {
    available,
    switches: [...counts.keys()],
    repeatedSwitches: [...counts].filter(([, count]) => count > 1).map(([name]) => name),
    profileArgumentPresent: available ? counts.has('--user-data-dir') : null,
  };
}

module.exports = { launchRegistrationBrowser, describeBrowserLaunch };