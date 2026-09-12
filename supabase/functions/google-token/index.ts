// supabase/functions/google-token/index.ts — trades a Google sign-in for
// tokens that keep, so the planner is not asked to sign in every hour.
//
// A page cannot hold a client secret, so a browser-only sign-in gets an
// access token that lasts an hour and no quiet way to renew it. This runs
// on Supabase's edge, where the secret lives, and does the one exchange the
// secret is for: a sign-in code for an access token and a refresh token, or
// a refresh token for a fresh access token. It answers only to a signed-in
// user of this project. Deploy once, with the secret of the same OAuth
// client whose id is in Settings:
//
//   supabase secrets set GOOGLE_CLIENT_SECRET=…
//   supabase functions deploy google-token

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const reply = (status: number, body: string, type = 'text/plain') =>
  new Response(body, { status, headers: { ...CORS, 'Content-Type': type + '; charset=utf-8' } });

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

  const secret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!secret) return reply(500, 'GOOGLE_CLIENT_SECRET is not set: supabase secrets set GOOGLE_CLIENT_SECRET=…');

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return reply(400, 'JSON body expected'); }
  const { client_id, grant, code, redirect_uri, refresh_token } = body || {};
  if (!client_id) return reply(400, 'client_id missing');

  const form = new URLSearchParams({ client_id, client_secret: secret });
  if (grant === 'code' && code) {
    form.set('grant_type', 'authorization_code');
    form.set('code', code);
    // 'postmessage' is what a popup sign-in was made under; a redirect names its page
    form.set('redirect_uri', redirect_uri || 'postmessage');
  } else if (grant === 'refresh' && refresh_token) {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', refresh_token);
  } else {
    return reply(400, 'grant must be code (with code) or refresh (with refresh_token)');
  }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const text = await r.text();
  // Google says what went wrong as JSON ({ error, error_description }); the
  // app reads `error` to tell a grant that has ended from a bad day
  if (!r.ok) return reply(r.status === 400 || r.status === 401 ? 400 : 502, text, 'application/json');

  // only what the app keeps; the id token and the rest stay here
  const j = JSON.parse(text);
  return reply(200, JSON.stringify({
    access_token: j.access_token, expires_in: j.expires_in,
    ...(j.refresh_token ? { refresh_token: j.refresh_token } : {})
  }), 'application/json');
});
