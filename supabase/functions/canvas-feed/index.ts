// supabase/functions/canvas-feed/index.ts — fetches your Canvas calendar feed
// so the app can, from a phone, without a file.
//
// Instructure sends no CORS headers, so a browser cannot read the feed
// itself. This runs on Supabase's edge, reads the feed URL you saved in
// planner_feeds (yours alone, under row level security), fetches it, and
// hands the text back. Deploy once:
//
//   supabase functions deploy canvas-feed
//
// or paste this file into Edge Functions → New function in the dashboard.
// It needs no secrets of its own: the project URL and anon key are set for
// every function, and the caller's own token is what it acts as.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

const reply = (status: number, body: string, type = 'text/plain') =>
  new Response(body, { status, headers: { ...CORS, 'Content-Type': type + '; charset=utf-8' } });

/** Anything on instructure.com, or a school's own Canvas: a `canvas` label
 *  under a domain ending .edu (canvas.school.edu, x.canvas.school.edu). The
 *  same test as isCanvasHost() in js/canvas.js. */
function canvasHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.endsWith('.instructure.com')) return true;
  const labels = host.split('.');
  const at = labels.indexOf('canvas');
  return at >= 0 && labels[labels.length - 1] === 'edu' && labels.length - at >= 3;
}

/** Only a Canvas host, only over https: this function fetches on your behalf,
 *  and a URL that could point anywhere would fetch anything. */
function allowed(raw: string, base?: URL): URL | null {
  let u: URL;
  try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  return canvasHost(u.hostname) ? u : null;
}

/** Redirects are followed by hand, each one checked like the first link:
 *  fetch left to itself would follow one anywhere. */
const MAX_HOPS = 4;
async function fetchCanvas(first: URL, signal: AbortSignal): Promise<Response> {
  let url = first;
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { signal, redirect: 'manual', headers: { Accept: 'text/calendar' } });
    if (res.status < 300 || res.status >= 400) return res;
    const to = res.headers.get('Location');
    await res.body?.cancel();
    if (!to) throw new Error(`Canvas answered ${res.status} with nowhere to go`);
    if (hop >= MAX_HOPS) throw new Error('Canvas sent us round too many redirects');
    const next = allowed(to, url);
    if (!next) throw new Error('Canvas redirected off Canvas');
    url = next;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') return reply(405, 'GET only');

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return reply(401, 'Sign in first');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } }
  );
  const { data: who, error: whoErr } = await supabase.auth.getUser();
  if (whoErr || !who?.user) return reply(401, 'Sign in first');

  const { data: row, error } = await supabase
    .from('planner_feeds')
    .select('url')
    .eq('user_id', who.user.id)
    .maybeSingle();
  if (error) return reply(500, error.message);
  // no link saved is not an error: the app asks once a day and takes 204 as "nothing to do"
  if (!row?.url) return new Response(null, { status: 204, headers: CORS });

  const url = allowed(row.url);
  if (!url) return reply(400, 'That is not a Canvas feed link (https, on an instructure.com host).');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetchCanvas(url, ctl.signal);
    if (!res.ok) return reply(502, `Canvas answered ${res.status}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) return reply(502, 'Canvas did not send a calendar');
    return reply(200, text, 'text/calendar');
  } catch (e) {
    return reply(504, `Could not reach Canvas: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
});
