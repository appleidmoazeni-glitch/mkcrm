'use strict';

const JALALI_MIN_YEAR = 1200;
const JALALI_MAX_YEAR = 1599;

function toEnglishDigits(value = '') {
  return String(value ?? '')
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

function dateError(field, value, reason) {
  const error = new Error(`${field} باید تاریخ شمسی معتبر با قالب YYYYMMDD باشد؛ مثال: 14050501${reason ? ` (${reason})` : ''}`);
  error.name = 'JalaliDateValidationError';
  error.code = 'INVALID_JALALI_DATE';
  error.statusCode = 400;
  error.field = field;
  error.inputLength = String(value ?? '').trim().length;
  return error;
}

function assertValidJalaliParts(year, month, day, field, value) {
  if (year < JALALI_MIN_YEAR || year > JALALI_MAX_YEAR) throw dateError(field, value, 'سال خارج از محدوده شمسی پشتیبانی‌شده است');
  if (month < 1 || month > 12) throw dateError(field, value, 'ماه باید بین 01 و 12 باشد');
  // Esfand 30 is accepted here because leap-year authority belongs to Shaygan;
  // structural validation must not reject a date that Shaygan accepts.
  const maxDay = month <= 6 ? 31 : 30;
  if (day < 1 || day > maxDay) throw dateError(field, value, `روز این ماه باید بین 01 و ${String(maxDay).padStart(2, '0')} باشد`);
}

function normalizeJalaliDate(value, options = {}) {
  const field = options.field || 'date';
  const required = options.required === true;
  const raw = toEnglishDigits(value).trim();
  if (!raw) {
    if (required) throw dateError(field, value, 'مقدار الزامی است');
    return '';
  }

  const compactMatch = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  const separatedMatch = raw.match(/^(\d{4})([/-])(\d{2})\2(\d{2})$/);
  if (!compactMatch && !separatedMatch) throw dateError(field, value, 'فقط ارقام و جداکننده یکسان / یا - مجاز است');

  const year = Number((compactMatch || separatedMatch)[1]);
  const month = Number(compactMatch ? compactMatch[2] : separatedMatch[3]);
  const day = Number(compactMatch ? compactMatch[3] : separatedMatch[4]);
  assertValidJalaliParts(year, month, day, field, value);
  return `${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

function normalizeJalaliMonth(value, options = {}) {
  const field = options.field || 'month';
  const raw = toEnglishDigits(value).trim();
  if (!raw) return '';
  const compactMatch = raw.match(/^(\d{4})(\d{2})$/);
  const separatedMatch = raw.match(/^(\d{4})[/-](\d{2})$/);
  if (!compactMatch && !separatedMatch) throw dateError(field, value, 'ماه باید با قالب YYYYMM باشد');
  const match=compactMatch||separatedMatch;
  const digits=`${match[1]}${match[2]}`;
  normalizeJalaliDate(`${digits}01`, { field, required: true });
  return digits;
}

function normalizeJalaliRange(input = {}, options = {}) {
  const dateFrom = normalizeJalaliDate(input.dateFrom ?? input.from ?? '', {
    field: options.fromField || 'dateFrom',
    required: options.requireFrom === true
  });
  const dateTo = normalizeJalaliDate(input.dateTo ?? input.to ?? '', {
    field: options.toField || 'dateTo',
    required: options.requireTo === true
  });
  if (dateFrom && dateTo && dateFrom > dateTo) {
    const error = new Error('dateFrom نباید بعد از dateTo باشد');
    error.name = 'JalaliDateValidationError';
    error.code = 'INVALID_JALALI_DATE_RANGE';
    error.statusCode = 400;
    error.field = 'dateRange';
    throw error;
  }
  return { dateFrom, dateTo };
}

function shiftJalaliDate(value, days, options = {}) {
  const field = options.field || 'date';
  const amount = Number(days);
  if (!Number.isInteger(amount)) throw dateError(field, value, 'جابجایی روز باید عدد صحیح باشد');
  let date = normalizeJalaliDate(value, { field, required: true });
  let year = Number(date.slice(0, 4));
  let month = Number(date.slice(4, 6));
  let day = Number(date.slice(6, 8));
  const direction = amount < 0 ? -1 : 1;
  const monthLength = currentMonth => currentMonth <= 6 ? 31 : 30;
  for (let remaining = Math.abs(amount); remaining > 0; remaining -= 1) {
    day += direction;
    if (direction > 0 && day > monthLength(month)) {
      day = 1; month += 1;
      if (month > 12) { month = 1; year += 1; }
    } else if (direction < 0 && day < 1) {
      month -= 1;
      if (month < 1) { month = 12; year -= 1; }
      day = monthLength(month);
    }
  }
  return normalizeJalaliDate(`${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`, { field, required: true });
}

function isValidGregorianDate(year, month, day) {
  if (year < 1700 || year > 2299 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function gregorianToJalali(year, month, day) {
  const monthOffsets = [0,31,59,90,120,151,181,212,243,273,304,334];
  let jy = year <= 1600 ? 0 : 979;
  let gy = year - (year <= 1600 ? 621 : 1600);
  const gy2 = month > 2 ? gy + 1 : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) - 80 + day + monthOffsets[month - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return `${String(jy).padStart(4, '0')}${String(jm).padStart(2, '0')}${String(jd).padStart(2, '0')}`;
}

function canonicalSaleDate(value, options = {}) {
  const field = options.field || 'saleDate';
  const raw = toEnglishDigits(value).trim();
  if (!raw) {
    if (options.required) throw dateError(field, value, 'مقدار الزامی است');
    return '';
  }
  const compactMatch = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  const separatedMatch = raw.match(/^(\d{4})([/-])(\d{2})\2(\d{2})$/);
  if (!compactMatch && !separatedMatch) throw dateError(field, value, 'تاریخ منبع باید 8 رقم یا دارای جداکننده استاندارد باشد');
  const match = compactMatch || separatedMatch;
  const year = Number(match[1]);
  const month = Number(compactMatch ? compactMatch[2] : separatedMatch[3]);
  const day = Number(compactMatch ? compactMatch[3] : separatedMatch[4]);
  if (year >= JALALI_MIN_YEAR && year <= JALALI_MAX_YEAR) {
    return normalizeJalaliDate(`${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`, { field, required: true });
  }
  if (!isValidGregorianDate(year, month, day)) throw dateError(field, value, 'تاریخ منبع نه شمسی معتبر است و نه Gregorian معتبر');
  return gregorianToJalali(year, month, day);
}

module.exports = {
  toEnglishDigits,
  normalizeJalaliDate,
  normalizeJalaliMonth,
  normalizeJalaliRange,
  shiftJalaliDate,
  canonicalSaleDate,
  gregorianToJalali
};
