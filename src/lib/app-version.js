'use strict';

const { execFileSync } = require('child_process');
const packageMetadata = require('../../package.json');

const APP_NAME = String(packageMetadata.name || 'mkcrm');
const APP_VERSION = String(packageMetadata.version || 'unknown');

function boundedMetadata(value) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, 128) : null;
}

let cachedBuildMetadata;
function localBuildMetadata() {
  if (cachedBuildMetadata) return cachedBuildMetadata;
  const read = args => { try { return boundedMetadata(execFileSync('git', args, { cwd:process.cwd(), encoding:'utf8', timeout:1000, windowsHide:true, stdio:['ignore','pipe','ignore'] })); } catch (_) { return null; } };
  cachedBuildMetadata = { gitSha:read(['rev-parse','HEAD']), sourceBranch:read(['rev-parse','--abbrev-ref','HEAD']), buildTimestamp:read(['show','-s','--format=%cI','HEAD']) };
  return cachedBuildMetadata;
}

function versionPayload(env = process.env) {
  const local=localBuildMetadata();
  const gitSha=boundedMetadata(env.GIT_COMMIT||env.COMMIT_SHA||env.SOURCE_VERSION)||local.gitSha;
  const sourceBranch=boundedMetadata(env.SOURCE_BRANCH||env.GIT_BRANCH)||local.sourceBranch;
  const buildTimestamp=boundedMetadata(env.BUILD_TIMESTAMP||env.BUILD_TIME)||local.buildTimestamp;
  const releaseMetadataReady=/^[0-9a-f]{40}$/i.test(gitSha||'');
  return {
    ok: true,
    name: APP_NAME,
    version: APP_VERSION,
    commit: gitSha,
    applicationVersion:APP_VERSION,
    gitSha,
    sourceBranch,
    buildTimestamp,
    environment: boundedMetadata(env.APP_ENV || env.NODE_ENV),
    releaseMetadataReady,
    releaseBlockers:releaseMetadataReady?[]:['GIT_SHA_MISSING_OR_INVALID']
  };
}

function injectAssetVersion(html) {
  return String(html).replaceAll('__MKCRM_VERSION__', encodeURIComponent(APP_VERSION));
}

module.exports = { APP_NAME, APP_VERSION, versionPayload, injectAssetVersion };
