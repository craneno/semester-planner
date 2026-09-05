// store/urls.js — a URL made safe, and a name guessed from it. Pure.
//
// Titles are derived from the URL and nowhere else. A page's real <title>
// cannot be read from here: a cross-origin fetch returns a response the page
// is not allowed to look inside. So the guess is editable, and that is the
// point rather than a gap.

export const URL_HEAD = /^(?:https?:\/\/|www\.)/i;
export const BARE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * http(s) only, always absolute. Anything else is refused rather than stored:
 * a `javascript:` URL saved here would run as this page the moment it is
 * clicked, and the whole point of the pile is that you click things in it.
 */
/** `scheme://`, or one of the schemes written without slashes. A bare host
 *  with a port — "example.com:8000/x" — is neither, and gets https. */
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|tel|sms|javascript|data|blob|about|file|vbscript):)/i;

export function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const withScheme = HAS_SCHEME.test(text) ? text : 'https://' + text;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  return u.href;
}

/** Path segments that name nothing: every site has them. */
const EMPTY_SEGMENT = /^(?:index|home|default|main|page|view|watch|item|post|article|en|us)$/i;

/* A file on Google Drive is addressed by an opaque id and nothing else, so
   there is no name in the URL to find — only a 33-character key that the hash
   rule below would throw away, leaving the bare host. Naming the *kind* of
   thing is the honest guess: "Google Doc" is a far better starting point to
   correct than "1BxiMVs0XRA — docs.google.com". Drive will not tell us the
   real name either; that needs an API key and a scope this app does not ask
   for. Rename it in the pile. */
const GOOGLE_DOC_KIND = {
  document: 'Google Doc', spreadsheets: 'Google Sheet', presentation: 'Google Slides',
  forms: 'Google Form', drawings: 'Google Drawing'
};

function googleFileTitle(u) {
  const host = u.hostname.replace(/^www\./i, '');
  const segs = u.pathname.split('/').filter(Boolean);
  if (host === 'docs.google.com') return GOOGLE_DOC_KIND[segs[0]] || null;
  if (host === 'drive.google.com') {
    if (segs.includes('folders')) return 'Drive folder';
    if (segs.includes('d') || segs[0] === 'file' || segs[0] === 'open') return 'Drive file';
    return null;
  }
  return null;
}

/** A readable name for a URL, from the URL alone. */
export function linkTitleFromUrl(raw) {
  const href = normalizeUrl(raw);
  if (!href) return '';
  const u = new URL(href);
  const host = u.hostname.replace(/^www\./i, '');
  const drive = googleFileTitle(u);
  if (drive) return drive;
  const segs = u.pathname.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const name = prettySegment(segs[i]);
    if (name) return `${name} — ${host}`;
  }
  return host;
}

/** '/semester-planner.html' -> 'Semester planner'; an id or a hash -> ''. */
function prettySegment(seg) {
  let s = seg;
  try { s = decodeURIComponent(s); } catch { /* keep it as it came */ }
  s = s.replace(/\.(html?|php|aspx?|jsp|cgi|pdf|docx?|pptx?|txt|md)$/i, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || EMPTY_SEGMENT.test(s)) return '';
  if (/^\d+$/.test(s)) return '';                       // an id
  if (s.length > 60) return '';                         // a token
  if (s.length > 8 && !/[aeiou]/i.test(s)) return '';    // a hash
  return s.charAt(0).toUpperCase() + s.slice(1);
}
