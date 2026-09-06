// supabase/functions/track-parcel/index.ts — asks a carrier where a parcel
// is, so the wishlist can say when it lands.
//
// FedEx, UPS and USPS all want an OAuth client of your own and none of them
// send CORS headers, so a page cannot ask them. This runs on Supabase's edge
// as you (your own token is checked first), holds the carriers' keys as
// project secrets, and hands back one small JSON whatever the carrier's own
// shape. Deploy once, and set the secrets for the carriers you use:
//
//   supabase functions deploy track-parcel
//   supabase secrets set FEDEX_CLIENT_ID=… FEDEX_CLIENT_SECRET=…
//   supabase secrets set UPS_CLIENT_ID=… UPS_CLIENT_SECRET=…
//   supabase secrets set USPS_CLIENT_ID=… USPS_CLIENT_SECRET=…
//
// FedEx: developer.fedex.com → a project with the Track API. UPS:
// developer.ups.com → an app with Tracking. USPS: developers.usps.com → an
// app with Tracking 3.2 (3.0 is going away). Sandboxes: FEDEX_API=https://apis-sandbox.fedex.com,
// UPS_API=https://wwwcie.ups.com, USPS_API=https://apis-tem.usps.com.
//
// A carrier with no keys answers 501, and the app shows that on the row: the
// link to the carrier's page works regardless.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': (typeof body === 'string' ? 'text/plain' : 'application/json') + '; charset=utf-8' }
  });

/** What the app gets, whatever the carrier said. */
type Answer = {
  carrier: string;
  number: string;
  status: 'transit' | 'out' | 'delivered' | 'exception' | 'unknown';
  summary: string;                                  // one line, the carrier's words
  eta: string | null;                               // 'YYYY-MM-DD'
  etaTime: string | null;                           // 'HH:MM', the end of the window
  window: { from: string; to: string } | null;      // 'HH:MM'
  lastEvent: { at: string | null; text: string } | null;
  at: string;                                       // when this was asked
};

const env = (k: string) => Deno.env.get(k) || '';

/* ---------------- OAuth, cached per carrier ---------------- */

const tokens: Record<string, { value: string; until: number }> = {};

async function token(carrier: string, url: string, body: URLSearchParams, headers: Record<string, string> = {}) {
  const have = tokens[carrier];
  if (have && have.until > Date.now() + 60_000) return have.value;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body
  });
  if (!res.ok) throw new Error(`${carrier} would not issue a token (${res.status})`);
  const json = await res.json();
  tokens[carrier] = { value: json.access_token, until: Date.now() + (Number(json.expires_in) || 3000) * 1000 };
  return json.access_token as string;
}

/* ---------------- shaping ---------------- */

/** 'YYYY-MM-DD' out of an ISO string, a 'YYYYMMDD', or nothing. */
const day = (v: unknown): string | null => {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
/** 'HH:MM' out of an ISO string, a 'HHMMSS', or nothing. */
const clock = (v: unknown): string | null => {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/T(\d{2}):(\d{2})/) || s.match(/^(\d{2}):?(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
};
const title = (s: unknown) => String(s || '').trim().replace(/\s+/g, ' ');

/* ---------------- FedEx ---------------- */

async function fedex(number: string): Promise<Answer | null> {
  const id = env('FEDEX_CLIENT_ID'), secret = env('FEDEX_CLIENT_SECRET');
  if (!id || !secret) return null;
  const api = env('FEDEX_API') || 'https://apis.fedex.com';
  const t = await token('fedex', `${api}/oauth/token`,
    new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }));
  const res = await fetch(`${api}/track/v1/trackingnumbers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
    body: JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }] })
  });
  if (!res.ok) throw new Error(`FedEx answered ${res.status}`);
  const json = await res.json();
  const r = json?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!r) throw new Error('FedEx sent nothing for that number');
  if (r.error) throw new Error(title(r.error.message) || 'FedEx does not know that number');

  const latest = r.latestStatusDetail || {};
  const code = String(latest.code || '');
  const times: Array<{ type: string; dateTime: string }> = r.dateAndTimes || [];
  const find = (type: string) => times.find((x) => x.type === type)?.dateTime;
  const delivered = find('ACTUAL_DELIVERY');
  const est = find('ESTIMATED_DELIVERY') || find('COMMITMENT');
  const win = r.estimatedDeliveryTimeWindow?.window;
  const scan = (r.scanEvents || [])[0];
  const where = scan?.scanLocation ? [scan.scanLocation.city, scan.scanLocation.stateOrProvinceCode].filter(Boolean).join(' ') : '';

  const status: Answer['status'] = delivered || code === 'DL' ? 'delivered'
    : code === 'OD' ? 'out'
      : /^(DE|SE|CA|RS)$/.test(code) ? 'exception'
        : code ? 'transit' : 'unknown';
  return {
    carrier: 'fedex', number, status,
    summary: title(latest.statusByLocale || latest.description || scan?.eventDescription) + (where ? ` · ${where}` : ''),
    eta: day(delivered || est),
    etaTime: clock(win?.ends) || (est ? clock(est) : null),
    window: win?.begins && win?.ends ? { from: clock(win.begins)!, to: clock(win.ends)! } : null,
    lastEvent: scan ? { at: scan.date || null, text: title(scan.eventDescription) } : null,
    at: new Date().toISOString()
  };
}

/* ---------------- UPS ---------------- */

async function ups(number: string): Promise<Answer | null> {
  const id = env('UPS_CLIENT_ID'), secret = env('UPS_CLIENT_SECRET');
  if (!id || !secret) return null;
  const api = env('UPS_API') || 'https://onlinetools.ups.com';
  const t = await token('ups', `${api}/security/v1/oauth/token`,
    new URLSearchParams({ grant_type: 'client_credentials' }),
    { Authorization: 'Basic ' + btoa(`${id}:${secret}`) });
  const res = await fetch(`${api}/api/track/v1/details/${encodeURIComponent(number)}?locale=en_US&returnSignature=false`, {
    headers: { Authorization: `Bearer ${t}`, transId: crypto.randomUUID(), transactionSrc: 'semester-planner' }
  });
  if (!res.ok) throw new Error(`UPS answered ${res.status}`);
  const json = await res.json();
  const pkg = json?.trackResponse?.shipment?.[0]?.package?.[0];
  if (!pkg) throw new Error('UPS sent nothing for that number');
  if (json.trackResponse.shipment[0].warnings?.length) throw new Error(title(json.trackResponse.shipment[0].warnings[0].message));

  const act = (pkg.activity || [])[0];
  const type = String(act?.status?.type || pkg.currentStatus?.type || '');
  const dates: Array<{ type: string; date: string }> = pkg.deliveryDate || [];
  const del = dates.find((d) => d.type === 'DEL')?.date;
  const est = (dates.find((d) => d.type === 'SDD') || dates.find((d) => d.type === 'RDD') || dates[0])?.date;
  const dt = pkg.deliveryTime || {};
  const where = act?.location?.address ? [act.location.address.city, act.location.address.stateProvince].filter(Boolean).join(' ') : '';
  const status: Answer['status'] = type === 'D' || del ? 'delivered'
    : type === 'O' ? 'out'
      : type === 'X' ? 'exception'
        : type ? 'transit' : 'unknown';
  const to = clock(dt.endTime), from = clock(dt.startTime);
  return {
    carrier: 'ups', number, status,
    summary: title(act?.status?.description || pkg.currentStatus?.description) + (where ? ` · ${where}` : ''),
    eta: day(del || est),
    etaTime: to,
    window: from && to ? { from, to } : null,
    lastEvent: act ? { at: act.date && act.time ? `${day(act.date)}T${clock(act.time)}` : null, text: title(act.status?.description) } : null,
    at: new Date().toISOString()
  };
}

/* ---------------- USPS ---------------- */

// Tracking 3.2: one POST with a list of numbers, a list back, one entry
// each. A number it cannot find comes back as its own entry with an `error`
// (a 207 when the list is mixed), not as a failed request.
async function usps(number: string): Promise<Answer | null> {
  const id = env('USPS_CLIENT_ID'), secret = env('USPS_CLIENT_SECRET');
  if (!id || !secret) return null;
  const api = env('USPS_API') || 'https://apis.usps.com';
  const t = await token('usps', `${api}/oauth2/v3/token`,
    new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }));
  const res = await fetch(`${api}/tracking/v3r2/tracking`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify([{ trackingNumber: number }])
  });
  const json = await res.json().catch(() => null);
  const r = Array.isArray(json) ? json[0] : json;
  const said = r?.error?.message || r?.error?.errors?.[0]?.detail;
  if (!res.ok && res.status !== 207) throw new Error(title(said) || `USPS answered ${res.status}`);
  if (!r || r.error) throw new Error(title(said) || 'USPS does not know that number');

  const cat = String(r.statusCategory || '').toLowerCase();
  const ev = (r.trackingEvents || [])[0];
  const where = ev ? [ev.eventCity, ev.eventState].filter(Boolean).join(' ') : '';
  const status: Answer['status'] = cat.includes('delivered') ? 'delivered'
    : cat.includes('out for delivery') ? 'out'
      : cat.includes('alert') || cat.includes('exception') ? 'exception'
        : cat ? 'transit' : 'unknown';
  // the expected date sits in its own block now, with a window beside it
  const x = r.deliveryDateExpectation || {};
  const from = clock(x.predictedDeliveryWindowStartTime), to = clock(x.predictedDeliveryWindowEndTime);
  return {
    carrier: 'usps', number, status,
    summary: title(r.status || r.statusSummary) + (where ? ` · ${where}` : ''),
    eta: day(status === 'delivered' ? ev?.eventTimestamp : (x.expectedDeliveryDate || x.predictedDeliveryDate || x.guaranteedDeliveryDate)),
    etaTime: clock(x.endOfDay) || to,
    window: from && to ? { from, to } : null,
    lastEvent: ev ? { at: ev.eventTimestamp || null, text: title(ev.eventType) } : null,
    at: new Date().toISOString()
  };
}

const ASK: Record<string, (n: string) => Promise<Answer | null>> = { fedex, ups, usps };

/* ---------------- the function ---------------- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, 'POST only');

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return reply(401, 'Sign in first');
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } }
  );
  const { data: who, error: whoErr } = await supabase.auth.getUser();
  if (whoErr || !who?.user) return reply(401, 'Sign in first');

  let body: { carrier?: string; number?: string } = {};
  try { body = await req.json(); } catch { return reply(400, 'Send { carrier, number }'); }
  const carrier = String(body.carrier || '').toLowerCase();
  const number = String(body.number || '').replace(/[\s-]/g, '').toUpperCase();
  if (!ASK[carrier]) return reply(400, `Unknown carrier: ${carrier || '(none)'}`);
  if (!/^[0-9A-Z]{10,34}$/.test(number)) return reply(400, 'That is not a tracking number');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const answer = await ASK[carrier](number);
    if (!answer) return reply(501, `${carrier.toUpperCase()} tracking is not set up on the server: set ${carrier.toUpperCase()}_CLIENT_ID and ${carrier.toUpperCase()}_CLIENT_SECRET (README → Parcel tracking)`);
    return reply(200, answer);
  } catch (e) {
    return reply(502, (e as Error).message || 'The carrier could not be reached');
  } finally {
    clearTimeout(timer);
  }
});
