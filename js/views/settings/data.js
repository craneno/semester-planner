// views/settings/data.js — export, restore, erase, and the copies kept here.

import { h, saveFile } from '../../util.js';
import { state, exportJson, importJson, listBackups, readBackup } from '../../store.js';
import { toast, confirmDialog } from '../../ui.js';
import * as C from '../../cloud.js';
import { section } from './bits.js';

export function renderData({ navigate }) {
  const fileInput = h('input', {
    type: 'file', accept: 'application/json', style: { display: 'none' },
    onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      try {
        const merge = await confirmDialog('Merge or replace?',
          'Merge keeps what is already here and adds anything new. Replace overwrites this device — and, with cloud sync on, the cloud takes this copy as the truth.', 'Merge');
        // a replaced copy has rows the sync baseline still lists; kept, the
        // next push would read every one of them as deleted here and
        // tombstone them on every device
        if (!merge) C.resetLocalSyncState();
        importJson(text, { merge });
        if (!merge) C.start().catch(() => {});
        toast(merge ? 'Backup merged.' : 'Backup restored.');
        navigate();
      } catch (err) { toast('That file could not be read: ' + err.message); }
      e.target.value = '';
    }
  });

  return section('Data', [
    h('p', { style: { fontSize: '13px', color: 'var(--ink-2)', margin: '0 0 12px' } },
      `Everything lives in this browser's storage: ${state.items.length} tasks and ${state.areas.length} areas. Export before you clear site data.`),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', {
        class: 'btn primary', onclick: () => {
          saveFile(new Blob([exportJson()], { type: 'application/json' }), `planner-${new Date().toISOString().slice(0, 10)}.json`);
        }
      }, 'Export backup'),
      h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Restore from file'),
      fileInput,
      h('button', {
        class: 'btn ghost danger', onclick: async () => {
          if (await confirmDialog('Erase everything on this device?', 'Tasks, areas, and settings. Export first if you want them back.', 'Erase')) {
            // the sync baseline and cursor go too, or a later sign-in reads
            // the empty copy as "everything deleted here" and says so to the cloud
            C.resetLocalSyncState();
            for (const k of Object.keys(localStorage)) {
              if (k.startsWith('semesterPlanner.')) localStorage.removeItem(k);
            }
            location.reload();
          }
        }
      }, 'Erase all data')),
    backupList()
  ]);
}

/* Copies this device kept on its own.
   Sync is fan-out, not safety: a bad row reaches every device in seconds and
   the server keeps no history. These are taken before the app touches
   anything — one a day, plus one the moment a schema upgrade is about to run,
   which is when every row changes shape at once. They never leave the device
   and nothing that syncs can reach them. */

/** Bytes this origin holds in localStorage — a phone's quota is about 5 MB. */
function storageUsed() {
  let n = 0;
  try {
    for (const k of Object.keys(localStorage)) n += (k.length + (localStorage.getItem(k) || '').length) * 2;
  } catch { /* blocked */ }
  return n;
}

function backupList() {
  const backups = listBackups();
  const mb = (storageUsed() / 1048576).toFixed(1);
  const room = h('p', { style: { fontSize: '12.5px', color: C.cloud.storageFull ? 'var(--danger)' : 'var(--ink-3)', margin: '6px 0 0' } },
    `${mb} MB held on this device.`
    + (C.cloud.storageFull ? ' That is all it will hold: sync cannot remember what it sent, so it sends everything. Save a copy, then free some space.' : ''));
  if (!backups.length) return room;

  const rows = backups.map((b) => {
    const pre = b.label.startsWith('before-');
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0' } },
      h('span', { class: 'num', style: { fontSize: '12.5px', minWidth: '110px' } },
        pre ? 'before ' + b.label.slice(7) : b.label),
      h('span', { style: { fontSize: '12px', color: 'var(--ink-3)', flex: 1 } },
        pre ? 'taken as the upgrade ran' : `${Math.round(b.size / 1024)} KB`),
      h('button', {
        class: 'btn sm', onclick: () => {
          const text = readBackup(b.key);
          if (!text) return toast('That copy is gone.');
          saveFile(new Blob([text], { type: 'application/json' }), `planner-${b.label}.json`);
        }
      }, 'Save'));
  });

  return h('div', { style: { marginTop: '6px' } },
    h('div', { class: 'eyebrow', style: { marginBottom: '4px' } }, 'Copies kept on this device'),
    h('p', { class: 'help', style: { margin: '0 0 6px' } },
      'Taken before anything is read, so a bad sync cannot reach them. Save one, '
      + 'then Restore from file to put it back.'),
    ...rows, room);
}
