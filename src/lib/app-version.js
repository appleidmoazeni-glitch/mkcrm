'use strict';

const packageMetadata = require('../../package.json');

const APP_NAME = String(packageMetadata.name || 'mkcrm');
const APP_VERSION = String(packageMetadata.version || 'unknown');

function boundedMetadata(value) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, 128) : null;
}

function versionPayload(env = process.env) {
  return {
    ok: true,
    name: APP_NAME,
    version: APP_VERSION,
    commit: boundedMetadata(env.GIT_COMMIT || env.COMMIT_SHA || env.SOURCE_VERSION),
    environment: boundedMetadata(env.APP_ENV || env.NODE_ENV)
  };
}

function injectAssetVersion(html) {
  return String(html).replaceAll('__MKCRM_VERSION__', encodeURIComponent(APP_VERSION));
}

module.exports = { APP_NAME, APP_VERSION, versionPayload, injectAssetVersion };
