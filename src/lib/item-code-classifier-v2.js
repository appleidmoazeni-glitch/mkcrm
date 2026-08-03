const KNOWN_BRANDS = new Set([
  'adata', 'amd', 'asus', 'corsair', 'crucial', 'gigabyte', 'hp', 'intel',
  'kingston', 'lenovo', 'logitech', 'msi', 'patriot', 'samsung', 'western digital'
]);

const GENERIC_PRODUCT_TERMS = new Set([
  'cpu', 'gpu', 'hdd', 'keyboard', 'laptop', 'memory', 'monitor', 'mouse',
  'notebook', 'printer', 'ram', 'ssd'
]);

function normalizeClassifierInput(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/‌/g, ' ')
    .replace(/\s+/g, ' ');
}

function hasValidGtinChecksum(value) {
  if (!/^\d{8}$|^\d{12,14}$/.test(value)) return false;
  const digits = value.split('').map(Number);
  const checkDigit = digits.pop();
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === checkDigit;
}

class ItemCodeClassifierV2 {
  classify(value = '') {
    const normalized = normalizeClassifierInput(value);
    if (!normalized) return { classification:'unknown', confidence:0, reason:'empty-query' };

    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length > 1) {
      return { classification:'mixed_query', confidence:0.99, reason:'multiple-search-tokens' };
    }

    const token = tokens[0];
    if (hasValidGtinChecksum(token)) {
      return { classification:'barcode', confidence:0.99, reason:'valid-gtin-checksum' };
    }
    if (KNOWN_BRANDS.has(token)) {
      return { classification:'brand', confidence:0.99, reason:'known-brand-token' };
    }
    if (GENERIC_PRODUCT_TERMS.has(token)) {
      return { classification:'generic_text', confidence:0.98, reason:'generic-product-token' };
    }

    const hasLetter = /[a-zآ-ی]/i.test(token);
    const hasDigit = /\d/.test(token);
    const hasCodeSeparator = /[-_/]/.test(token);
    const supportedCodeShape = /^[0-9a-zآ-ی_/-]+$/i.test(token);

    if (supportedCodeShape && hasLetter && hasDigit && token.length >= 7 && (hasCodeSeparator || /\d{4,}/.test(token))) {
      return { classification:'definite_code', confidence:0.95, reason:hasCodeSeparator?'alphanumeric-with-code-separator':'strong-alphanumeric-pattern' };
    }
    if (supportedCodeShape && hasLetter && hasDigit && token.length >= 5) {
      return { classification:'probable_code', confidence:0.78, reason:'mixed-alphanumeric-token' };
    }
    if (/^\d{5,7}$/.test(token)) {
      return { classification:'probable_code', confidence:0.72, reason:'short-numeric-model-or-code' };
    }
    if (/^[a-zآ-ی]+$/i.test(token)) {
      return { classification:'generic_text', confidence:0.75, reason:'alphabetic-search-token' };
    }
    return { classification:'unknown', confidence:0.35, reason:'unrecognized-pattern' };
  }
}

function isV2CodeDecision(classification) {
  return ['definite_code', 'probable_code', 'barcode'].includes(classification);
}

function compareItemCodeClassifiers(value, oldDecision, classifier = new ItemCodeClassifierV2()) {
  const result = classifier.classify(value);
  const newDecision = isV2CodeDecision(result.classification);
  return {
    normalizedQuery:normalizeClassifierInput(value),
    sameDecision:Boolean(oldDecision) === newDecision,
    differentDecision:Boolean(oldDecision) !== newDecision,
    oldDecision:Boolean(oldDecision),
    newDecision,
    classification:result.classification,
    confidence:result.confidence,
    reason:result.reason
  };
}

module.exports = {
  ItemCodeClassifierV2,
  compareItemCodeClassifiers,
  hasValidGtinChecksum,
  isV2CodeDecision,
  normalizeClassifierInput
};
