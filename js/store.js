// localStorage wrapper. Every access is guarded: private mode, cleared site
// data or a full quota must never break the app — it just runs without memory.

const NS = 'iyar.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_SETTINGS = {
  currency: 'BHD',
  vatRate: 0.1,
  vatBasis: 'full',
  defaultKarat: 21,
  adjustPct: 0,
  priceMode: 'auto', // 'auto' | 'manual'
  manualKarat: 21,
  manualPrice: '',
  digits: 'latn', // 'latn' | 'arab'
  theme: 'system', // 'system' | 'light' | 'dark'
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
