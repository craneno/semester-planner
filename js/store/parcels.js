// store/parcels.js — a parcel by its number. Pure: which carrier a tracking
// number belongs to, where its page is, and how a carrier's answer lands on
// a wish. The asking is in js/tracking.js; this has no state and no network.

export const CARRIERS = { fedex: 'FedEx', ups: 'UPS', usps: 'USPS' };

/* Each carrier numbers its parcels its own way, and the shapes barely
   overlap: UPS starts 1Z; USPS runs 20–22 digits from 92–95 or is two
   letters, nine digits and US; FedEx is 12, 15, or 20–22 digits from 96.
   A price has a $ in front and a phone number has too few digits, so a bare
   run of twelve digits on the wishlist is a FedEx number and nothing else. */
const SHAPES = [
  [/^1Z[0-9A-Z]{16}$/i, 'ups'],
  [/^[A-Z]{2}\d{9}US$/i, 'usps'],
  [/^9[2-5]\d{18,20}$/, 'usps'],
  [/^96\d{18,20}$/, 'fedex'],
  [/^\d{12}$/, 'fedex'],
  [/^\d{15}$/, 'fedex']
];

/** The carrier a bare token belongs to, or null. */
export function carrierOf(token) {
  const t = String(token || '').replace(/[\s-]/g, '');
  for (const [re, carrier] of SHAPES) if (re.test(t)) return carrier;
  return null;
}

/**
 * The tracking number in a line, if there is one: `{ number, carrier, raw }`,
 * `raw` being the text it was typed as so the caller can take it out of the
 * name. Typed with the spaces the label prints ("5419 5824 7270") counts too.
 */
export function detectTracking(text) {
  const s = ' ' + String(text || '') + ' ';
  // whole tokens first, then digit groups with spaces or dashes between
  const tries = [
    ...s.split(/\s+/),
    ...[...s.matchAll(/\b\d{4}(?:[ -]\d{4}){2,4}(?:[ -]\d{1,4})?\b/g)].map((m) => m[0])
  ];
  for (const raw of tries) {
    const carrier = carrierOf(raw);
    if (carrier) return { number: raw.replace(/[\s-]/g, '').toUpperCase(), carrier, raw };
  }
  return null;
}

/** The carrier's own page for a parcel. */
export function trackingUrl(carrier, number) {
  const n = encodeURIComponent(number);
  if (carrier === 'ups') return `https://www.ups.com/track?tracknum=${n}`;
  if (carrier === 'usps') return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
}

/** A tracking record as kept on a wish, from whatever an older row holds. */
export function normalizeTracking(t) {
  if (!t || typeof t !== 'object') return null;
  const number = String(t.number || '').replace(/[\s-]/g, '').toUpperCase();
  const carrier = CARRIERS[t.carrier] ? t.carrier : carrierOf(number);
  if (!number || !carrier) return null;
  return {
    number, carrier,
    status: t.status || null,          // transit | out | delivered | exception | unknown
    summary: t.summary || '',          // one line, the carrier's words
    eta: t.eta || null,                // 'YYYY-MM-DD'
    etaTime: t.etaTime || null,        // 'HH:MM', the end of the window
    window: t.window && t.window.from && t.window.to ? { from: t.window.from, to: t.window.to } : null,
    checkedAt: t.checkedAt || null,
    error: t.error || null
  };
}

/**
 * Fold a carrier's answer into a wish. Returns what changed for the caller
 * to say: the date moved, it arrived, or nothing new. The wish's own `eta`
 * follows the carrier's — that is the whole point — but a date typed by hand
 * is kept when the carrier has none to give.
 */
export function applyTracking(w, res, now = new Date().toISOString()) {
  const t = normalizeTracking(w.tracking) || { number: '', carrier: 'fedex' };
  const before = { eta: w.eta, status: w.status };
  w.tracking = {
    ...t,
    status: res.status || 'unknown',
    summary: res.summary || '',
    eta: res.eta || null,
    etaTime: res.etaTime || null,
    window: res.window || null,
    checkedAt: now,
    error: null
  };
  if (res.eta) w.eta = res.eta;
  if (res.status === 'delivered') { w.status = 'delivered'; w.eta = null; }
  else if (w.status === 'ordered') w.status = 'shipped';   // a number that answers has shipped
  w.updatedAt = now;
  if (w.status === 'delivered' && before.status !== 'delivered') return 'delivered';
  if (w.eta !== before.eta) return 'moved';
  return 'same';
}

/** The carrier could not be asked: kept on the record, never on the date. */
export function failTracking(w, message, now = new Date().toISOString()) {
  const t = normalizeTracking(w.tracking);
  if (!t) return;
  w.tracking = { ...t, checkedAt: now, error: String(message || 'Could not check') };
  w.updatedAt = now;
}
