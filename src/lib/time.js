'use strict';

const TEHRAN_TZ = 'Asia/Tehran';

function now() {
  return new Date();
}

function toIso(d = now()) {
  const x = d instanceof Date ? d : new Date(d || Date.now());
  return Number.isNaN(x.getTime()) ? now().toISOString() : x.toISOString();
}

function formatTehranDateTime(input = now()) {
  const d = input instanceof Date ? input : new Date(input || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      timeZone: TEHRAN_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(d);
  } catch (_) {
    return d.toISOString();
  }
}

function serverTimePayload() {
  const d = now();
  return {
    ok: true,
    timezone: TEHRAN_TZ,
    serverNow: d,
    serverNowIso: d.toISOString(),
    serverNowTehran: formatTehranDateTime(d),
    source: 'server-clock'
  };
}

function stamp(extra = {}) {
  const d = now();
  return {
    ...extra,
    at: d,
    atIso: d.toISOString(),
    atTehran: formatTehranDateTime(d)
  };
}

module.exports = { TEHRAN_TZ, now, toIso, formatTehranDateTime, serverTimePayload, stamp };
