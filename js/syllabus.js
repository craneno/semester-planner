// syllabus.js — pull dates out of a syllabus, then make you approve every one.

import { h, clear, pad, today, MONTHS } from './util.js';
import { state, commit, upsertItem, ITEM_TYPES } from './store.js';
import { modal, closeModal, toast } from './ui.js';

const PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// order matters: the first match wins, so specific beats generic
const TYPE_HINTS = [
  [/\bquiz\b/i, 'quiz'],
  [/\b(midterm|final\s+exam|finals?\s+week|\bexam\b|\btest\b)/i, 'exam'],
  [/\b(hw|homework|problem\s?set|pset|ps\s*\d|assignment)\b/i, 'assignment'],
  [/\b(present|presentation|talk|defen[cs]e|demo)\b/i, 'presentation'],
  [/\b(lab|project|design\s+review|deliverable)\b/i, 'assignment'],
  [/\b(paper|essay|report|memo|proposal|draft|abstract|thesis)\b/i, 'paper'],
  [/\b(read|reading|chapter|ch\.|pp\.)\b/i, 'reading']
];

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = PDFJS_SRC;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      res(window.pdfjsLib);
    };
    s.onerror = () => rej(new Error('PDF reader could not load. Paste the text instead.'));
    document.head.append(s);
  });
}

async function extractText(file) {
  const lib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // rebuild lines by y position so table rows survive
    const rows = new Map();
    for (const it of content.items) {
      const y = Math.round(it.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(it.str);
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, parts]) => {
      const line = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (line) lines.push(line);
    });
  }
  return lines.join('\n');
}

/** Heuristic pass: any line with a date and something that reads like work. */
export function detect(text, { yearHint } = {}) {
  const year = yearHint || new Date(state.semester.start).getFullYear();
  const out = [];
  const seen = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (line.length < 4 || line.length > 220) continue;

    let date = null, dateText = '';
    let m = line.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'));
    if (m) {
      const mi = ABBR.indexOf(m[1].slice(0, 3).toLowerCase());
      date = `${year}-${pad(mi + 1)}-${pad(+m[2])}`;
      dateText = m[0];
    } else {
      m = line.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
      if (m) {
        const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : year;
        date = `${y}-${pad(+m[1])}-${pad(+m[2])}`;
        dateText = m[0];
      }
    }
    if (!date) continue;

    // keep it inside a sane window around the semester
    if (date < `${year - 1}-06-01` || date > `${year + 1}-08-31`) continue;

    const looksLikeWork = /\b(due|hw|homework|problem set|pset|ps\s*\d|assignment|quiz|exam|midterm|final|paper|essay|project|lab|present|report|draft|submit|read)\b/i.test(line);
    if (!looksLikeWork) continue;

    let title = line
      .replace(dateText, ' ')
      .replace(/\b(due|by|on|before)\b/gi, ' ')
      .replace(/^[\s\-–—:•*|]+|[\s\-–—:•*|]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^week\s+\d+\s*[:\-–]?\s*/i, '')
      .trim();
    if (title.length < 3) continue;
    if (title.length > 90) title = title.slice(0, 90).trim() + '…';

    const type = (TYPE_HINTS.find(([re]) => re.test(line)) || [null, 'assignment'])[1];
    const key = `${date}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, due: date, type, keep: true });
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : 1));
}

export function openSyllabusImport(navigate, presetAreaId = null) {
  let found = [];

  const areaSelect = h('select', {},
    h('option', { value: '' }, 'Unassigned'),
    ...state.areas.filter((a) => !a.archived).map((a) =>
      h('option', { value: a.id, selected: a.id === presetAreaId }, a.name)));

  const paste = h('textarea', {
    placeholder: 'Or paste the schedule table from your syllabus here — one row per line.',
    style: { minHeight: '120px' }
  });

  const fileInput = h('input', {
    type: 'file', accept: 'application/pdf',
    onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      status.textContent = 'Reading ' + f.name + '…';
      try {
        const text = await extractText(f);
        paste.value = text;
        run();
      } catch (err) {
        status.textContent = err.message;
      }
    }
  });

  const status = h('div', { class: 'eyebrow', style: { minHeight: '14px' } });
  const results = h('div', {});

  function run() {
    found = detect(paste.value);
    status.textContent = found.length
      ? `${found.length} possible ${found.length === 1 ? 'item' : 'items'} — uncheck anything wrong before importing`
      : 'Nothing recognisable yet. Paste the schedule table, or add items by hand.';
    drawResults();
  }

  function drawResults() {
    clear(results);
    if (!found.length) return;
    results.append(h('div', { class: 'eyebrow', style: { margin: '14px 0 4px' } }, 'Review'));
    found.forEach((f, i) => {
      results.append(h('div', {
        style: { display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) 130px 120px', gap: '8px', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--rule-soft)' }
      },
      h('input', { type: 'checkbox', class: 'check', checked: f.keep, onchange: (e) => { f.keep = e.target.checked; } }),
      h('input', { type: 'text', value: f.title, onchange: (e) => { f.title = e.target.value; } }),
      h('input', { type: 'date', value: f.due, onchange: (e) => { f.due = e.target.value; } }),
      h('select', { onchange: (e) => { f.type = e.target.value; } },
        ...ITEM_TYPES.map((t) => h('option', { value: t, selected: t === f.type }, t)))));
    });
  }

  modal({
    title: 'Import a syllabus',
    wide: true,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      h('div', { class: 'field' }, h('label', {}, 'Add everything to'), areaSelect),
      h('div', { class: 'field' }, h('label', {}, 'Syllabus PDF'), fileInput),
      h('div', { class: 'field' }, h('label', {}, 'Or paste text'), paste),
      h('button', { class: 'btn', style: { alignSelf: 'flex-start' }, onclick: run }, 'Find dates'),
      status,
      results),
    footer: [
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary', onclick: () => {
          const keep = found.filter((f) => f.keep && f.title.trim() && f.due);
          if (!keep.length) { toast('Nothing selected to import.'); return; }
          commit(() => {
            for (const f of keep) {
              upsertItem({ title: f.title.trim(), due: f.due, type: f.type, areaId: areaSelect.value || null, estMins: f.type === 'exam' ? 120 : 90 });
            }
          });
          closeModal();
          toast(`${keep.length} ${keep.length === 1 ? 'item' : 'items'} added.`);
          navigate?.();
        }
      }, 'Import selected')
    ]
  });
}
