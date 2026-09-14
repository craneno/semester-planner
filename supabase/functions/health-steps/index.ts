// supabase/functions/health-steps/index.ts — a day's steps, from the phone.
//
// A web app cannot read Apple Health. A Shortcut on the phone can, and can
// post a number to a URL: this is that URL. It takes { date, steps } with
// the token the planner made for you (Settings → Steps from your phone) in
// the x-planner-token header, finds whose token it is, and writes the day
// into planner_health. The app reads that table as you, once an hour.
//
// The caller is a Shortcut, not a signed-in session, so deploy it without
// the JWT check — the token is the proof:
//
//   supabase functions deploy health-steps --no-verify-jwt
//
// It needs no secrets of its own: the project URL and service role key are
// set for every function. The service role is used only to look the token
// up and write the one row; nothing here reads anything else.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-planner-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

/** What Shortcuts sends for a sum: 8420, "8420", "8,420", "8420 count", or a
 *  measurement dictionary like { value: 8420, unit: "count" }. A list is the
 *  samples themselves, not their sum, and is refused. Null when no number is in it. */
function readSteps(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (Array.isArray(v)) return null;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['value', 'magnitude', 'quantity', 'steps', 'sum', 'count']) if (k in o) return readSteps(o[k]);
    return null;
  }
  // digits, with thousands separators taken out; "8420 count" is 8420
  const m = String(v ?? '').replace(/[,\s\u00a0]/g, '').match(/\d+(\.\d+)?/);
  return m ? Math.round(Number(m[0])) : null;
}
const shown = (v: unknown) => { try { return JSON.stringify(v)?.slice(0, 80) ?? String(v); } catch { return String(v); } };

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const token = (req.headers.get('x-planner-token') || '').trim();
  if (!/^[a-f0-9]{32,64}$/i.test(token)) return reply(401, { error: 'No token. Make one under Settings → Steps from your phone, and send it as x-planner-token.' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: 'Send JSON: {"date":"YYYY-MM-DD","steps":8420}' }); }
  const date = String(body.date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply(400, { error: 'date must be YYYY-MM-DD' });
  const steps = readSteps(body.steps);
  // Refused, not written as 0: a 0 that was really "[object Object]" sat in
  // the app as a day with no steps, and nothing said why
  if (steps === null) {
    return reply(400, {
      error: `steps was not a number: ${shown(body.steps)}. Send the Sum from “Calculate Statistics” as a Number field.`
    });
  }
  if (steps > 500000) return reply(400, { error: 'steps must be a number of steps' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: who, error: whoErr } = await admin
    .from('planner_health_tokens').select('user_id').eq('token', token).maybeSingle();
  if (whoErr) return reply(500, { error: whoErr.message });
  if (!who?.user_id) return reply(401, { error: 'Unknown token. Make a new one under Settings → Steps from your phone.' });

  const { error } = await admin
    .from('planner_health')
    .upsert({ user_id: who.user_id, day: date, steps, updated_at: new Date().toISOString() });
  if (error) return reply(500, { error: error.message });
  return reply(200, { ok: true, date, steps });
});
