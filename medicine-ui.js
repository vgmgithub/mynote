// Medicine Cabinet screen (the "Medicines" tab inside Health Check). The rules live in medicine.js; this file only
// draws them and saves the records. One list for the household; a medicine can be tagged to a Health Check person.
// Ported from the sibling mynote-app repo (medicine-ui.js).
import { DB } from './db.js';
import { $, el, toast, openModal, closeModal, field, appConfirm, formSection } from './app.js';
import { todayISO } from './core.js';
import { MED_TYPES, MED_PURPOSES, MED_SOON_DAYS, DISPOSE_TIP, medStatus, comingUp, sortByExpiry, restockCopy, expiryLabel, statusText } from './medicine.js';

// Which list is showing (All / Coming up / Past) and the search text - kept while the person moves around.
let _medView = 'all';
let _medSearch = '';

const isClosed = (m) => m.status === 'used' || m.status === 'disposed';
const TYPE_ICON = { Tablet: '💊', Capsule: '💊', Syrup: '🧴', Drops: '💧', 'Cream / ointment': '🧴', Inhaler: '🌬️', Injection: '💉', 'Powder / sachet': '🥄', Spray: '💨' };

export async function renderMedicineCabinet(host, ctx) {
  const people = (ctx && ctx.people) || [];
  const rerender = (ctx && ctx.rerender) || (() => {});
  const meds = await DB.all('medicines').catch(() => []);
  const today = todayISO();
  const nameOf = (id) => { const p = people.find((x) => x.id === id); return p ? p.name : null; };

  const fab = $('#healthAddBtn');
  if (fab) {
    fab.classList.remove('hidden');
    fab.setAttribute('aria-label', 'Add medicine'); fab.title = 'Add medicine';
    fab.onclick = () => openMedicineForm(null, { people, rerender });
  }

  const active = meds.filter((m) => !isClosed(m));
  const closed = meds.filter(isClosed).sort((a, b) => String(b.closedOn || '').localeCompare(String(a.closedOn || '')));
  const soon = comingUp(active, today);
  const nExpired = soon.filter((m) => m._status.state === 'expired').length;
  const nSoon = soon.length - nExpired;

  // ---- Head: what is in the cabinet, and what needs doing ----
  host.appendChild(el('div', { class: 'med-head' }, [
    el('div', { class: 'med-head-title' }, [el('span', { class: 'med-head-ico', text: '💊' }), 'Medicine Cabinet']),
    el('div', { class: 'med-head-sub', text: active.length ? active.length + (active.length === 1 ? ' medicine' : ' medicines') + ' at home' : 'Nothing noted yet' }),
    (nExpired || nSoon) ? el('div', { class: 'med-head-badges' }, [
      nExpired ? el('span', { class: 'med-badge is-expired', text: nExpired + ' expired' }) : null,
      nSoon ? el('span', { class: 'med-badge is-soon', text: nSoon + ' expiring soon' }) : null,
    ].filter(Boolean)) : null,
  ].filter(Boolean)));

  if (!meds.length) {
    host.appendChild(el('div', { class: 'hc-empty' }, [
      el('div', { text: 'Note down the medicines at home - expiry, type, what each is for and how to take it.' }),
      el('div', { class: 'med-empty-sub', text: 'Anything expiring within ' + MED_SOON_DAYS + ' days shows under Coming up, so you can buy a fresh pack in time and throw the old one away safely.' }),
      el('button', { class: 'hc-empty-cta', text: '+ Add medicine', onclick: () => openMedicineForm(null, { people, rerender }) }),
    ]));
    return;
  }

  // ---- Which list, and search ----
  const chip = (v, label, n) => el('button', {
    type: 'button', class: 'pf-filter-chip' + (_medView === v ? ' active' : ''),
    onclick: () => { if (_medView === v) return; _medView = v; rerender(); },
  }, [label + (n ? ' · ' + n : '')]);
  host.appendChild(el('div', { class: 'pf-filter med-filter' }, [
    chip('all', 'All', active.length), chip('soon', 'Coming up', soon.length), chip('past', 'Used up / disposed', closed.length),
  ]));
  const search = el('input', { type: 'search', class: 'med-search', placeholder: 'Search name, purpose or use', value: _medSearch });
  host.appendChild(search);
  const listHost = el('div', {});
  host.appendChild(listHost);

  const matches = (m) => {
    const q = _medSearch.trim().toLowerCase();
    if (!q) return true;
    return [m.name, m.purpose, m.type, m.usage, nameOf(m.personId)].some((x) => String(x || '').toLowerCase().includes(q));
  };

  const card = (m, opts) => {
    const s = m._status || medStatus(m, today);
    const who = m.personId != null ? nameOf(m.personId) : null;
    const actions = [];
    if (opts && opts.actions) {
      actions.push(el('button', { type: 'button', class: 'med-act is-buy', onclick: (e) => { e.stopPropagation(); openMedicineForm(null, { people, rerender, restockOf: m }); } },
        [el('span', { class: 'med-act-plus', text: '+' }), 'Buy again']));
      if (s.state === 'expired') {
        actions.push(el('button', { type: 'button', class: 'med-act is-dispose', onclick: async (e) => { e.stopPropagation(); if (await disposeMedicine(m)) rerender(); } }, ['🗑️ Dispose']));
      }
    }
    return el('div', { class: 'med-card is-' + s.state, role: 'button', tabindex: '0', onclick: () => openMedicineForm(m, { people, rerender }) }, [
      el('div', { class: 'med-row' }, [
        el('span', { class: 'med-ico', text: TYPE_ICON[m.type] || '💊' }),
        el('div', { class: 'med-main' }, [
          el('div', { class: 'med-name', text: m.name || 'Medicine' }),
          el('div', { class: 'med-tags' }, [
            m.type ? el('span', { class: 'med-tag', text: m.type }) : null,
            m.purpose ? el('span', { class: 'med-tag is-purpose', text: m.purpose }) : null,
            el('span', { class: 'med-tag is-who', text: who || 'Household' }),
          ].filter(Boolean)),
        ]),
        el('div', { class: 'med-exp' }, [
          el('span', { class: 'med-exp-date', text: isClosed(m) ? (m.closedOn ? 'on ' + m.closedOn.split('-').reverse().join('/') : '') : 'Exp ' + expiryLabel(m.expiry) }),
          el('span', { class: 'med-status is-' + s.state, text: statusText(s) }),
        ]),
      ]),
      m.usage ? el('div', { class: 'med-usage' }, [el('b', { text: 'How to use: ' }), document.createTextNode(m.usage)]) : null,
      actions.length ? el('div', { class: 'med-acts' }, actions) : null,
    ].filter(Boolean));
  };

  const draw = () => {
    listHost.innerHTML = '';
    if (_medView === 'past') {
      const rows = closed.filter(matches);
      if (!rows.length) { listHost.appendChild(el('div', { class: 'hc-empty', text: _medSearch ? 'Nothing matches.' : 'Nothing used up or disposed yet.' })); return; }
      rows.forEach((m) => listHost.appendChild(card(m, { actions: true })));
      return;
    }
    const up = soon.filter(matches);
    if (up.length) {
      listHost.appendChild(el('div', { class: 'med-sec' }, [
        el('div', { class: 'med-sec-head' }, [el('span', { text: '⏰ Coming up' }), el('span', { class: 'med-sec-hint', text: 'buy again before it runs out of date' })]),
        ...up.map((m) => card(m, { actions: true })),
      ]));
      if (up.some((m) => m._status.state === 'expired')) listHost.appendChild(el('p', { class: 'hint med-tip' }, [el('b', { text: 'Disposing safely: ' }), document.createTextNode(DISPOSE_TIP)]));
    } else if (_medView === 'soon') {
      listHost.appendChild(el('div', { class: 'hc-empty', text: _medSearch ? 'Nothing matches.' : 'Nothing expires in the next ' + MED_SOON_DAYS + ' days.' }));
    }
    if (_medView === 'soon') return;
    const soonIds = new Set(soon.map((m) => m.id));
    const rest = sortByExpiry(active.filter((m) => !soonIds.has(m.id))).filter(matches);
    if (rest.length) {
      listHost.appendChild(el('div', { class: 'med-sec' }, [
        el('div', { class: 'med-sec-head' }, [el('span', { text: '🏠 In the cabinet' }), el('span', { class: 'med-sec-hint', text: 'soonest expiry first' })]),
        ...rest.map((m) => card(m)),
      ]));
    } else if (!up.length) {
      listHost.appendChild(el('div', { class: 'hc-empty', text: _medSearch ? 'Nothing matches.' : 'Everything here is used up or disposed.' }));
    }
  };
  search.addEventListener('input', () => { _medSearch = search.value; draw(); });
  draw();
}

async function disposeMedicine(m) {
  if (!(await appConfirm('Mark ' + (m.name || 'this medicine') + ' as disposed? ' + DISPOSE_TIP, { okText: 'Disposed', danger: false }))) return false;
  await DB.put('medicines', Object.assign({}, m, { status: 'disposed', closedOn: todayISO(), updatedAt: new Date().toISOString() }));
  delete (m)._status;
  toast('Disposed. Tap + Buy again on it under Used up / disposed if you still need it.');
  return true;
}

// Add, edit, or "buy again" (a new record copied from `o.restockOf`, with the option to dispose of the old pack).
export function openMedicineForm(existing, o) {
  const opts = o || {};
  const people = opts.people || [];
  const rerender = opts.rerender || (() => {});
  const base = existing || (opts.restockOf ? restockCopy(opts.restockOf) : {});
  const isEdit = !!existing;
  const today = todayISO();

  const name = el('input', { type: 'text', placeholder: 'e.g. Paracetamol 650', value: base.name || '' });
  const sel = (list, value, empty) => {
    const s = el('select', {}, [el('option', { value: '', text: empty }), ...list.map((t) => el('option', { value: t, text: t }))]);
    if (value && !list.includes(value)) s.appendChild(el('option', { value, text: value }));
    s.value = value || '';
    return s;
  };
  const type = sel(MED_TYPES, base.type, 'Select type');
  const purpose = sel(MED_PURPOSES, base.purpose, 'What is it for?');
  const usage = el('textarea', { rows: '3', placeholder: 'e.g. 1 tablet after food, up to 3 times a day' });
  usage.value = base.usage || '';
  const who = el('select', {}, [el('option', { value: '', text: 'Household (everyone)' }), ...people.map((p) => el('option', { value: String(p.id), text: p.name }))]);
  who.value = base.personId != null && people.some((p) => p.id === base.personId) ? String(base.personId) : '';
  const expiry = el('input', { type: 'month', value: base.expiry || '' });
  const bought = el('input', { type: 'date', value: base.boughtOn || (isEdit ? '' : today) });

  // Buying again: the old pack can be disposed of in the same step - ticked when it has already expired.
  let disposeOld = null;
  if (opts.restockOf && !isClosed(opts.restockOf)) {
    disposeOld = el('input', { type: 'checkbox' });
    disposeOld.checked = medStatus(opts.restockOf, today).state === 'expired';
  }

  const save = async () => {
    const n = name.value.trim();
    if (!n) { toast('Add the medicine name'); name.focus(); return; }
    if (!expiry.value) { toast('Add the expiry month from the pack'); expiry.focus(); return; }
    const now = new Date().toISOString();
    const rec = Object.assign({}, existing || {}, {
      name: n.slice(0, 80), type: type.value, purpose: purpose.value, usage: usage.value.trim().slice(0, 500),
      personId: who.value ? Number(who.value) : null, expiry: expiry.value, boughtOn: bought.value || '',
      status: (existing && existing.status) || 'active', closedOn: (existing && existing.closedOn) || null,
      updatedAt: now,
    });
    if (!isEdit) rec.createdAt = now;
    delete rec._status;
    await DB.put('medicines', rec);
    if (disposeOld && disposeOld.checked) {
      const old = Object.assign({}, opts.restockOf, { status: 'disposed', closedOn: today, updatedAt: now });
      delete old._status;
      await DB.put('medicines', old);
    }
    closeModal();
    toast(isEdit ? 'Medicine updated' : opts.restockOf ? 'New pack added' + (disposeOld && disposeOld.checked ? ', old one disposed' : '') : 'Medicine added');
    rerender();
  };
  const close = async (status) => {
    if (status === 'disposed') { if (!(await disposeMedicine(existing))) return; }
    else await DB.put('medicines', Object.assign({}, existing, { status, closedOn: status === 'active' ? null : today, updatedAt: new Date().toISOString() }));
    closeModal();
    if (status === 'used') toast('Marked used up');
    if (status === 'active') toast('Back in the cabinet');
    rerender();
  };
  const del = async () => {
    if (!(await appConfirm('Delete ' + (existing.name || 'this medicine') + ' for good?'))) return;
    await DB.del('medicines', existing.id);
    closeModal(); toast('Removed'); rerender();
  };

  const btns = [el('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: save })];
  if (isEdit && !isClosed(existing)) {
    btns.push(el('button', { class: 'btn ghost', type: 'button', text: 'Used up', onclick: () => close('used') }));
    btns.push(el('button', { class: 'btn ghost', type: 'button', text: 'Dispose', onclick: () => close('disposed') }));
  }
  if (isEdit && isClosed(existing)) btns.push(el('button', { class: 'btn ghost', type: 'button', text: 'Back in cabinet', onclick: () => close('active') }));
  if (isEdit) btns.push(el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: del }));
  btns.push(el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: closeModal }));

  openModal(el('div', { class: 'sheet has-fixed-footer' }, [
    el('div', { class: 'sheet-scroll' }, [
      el('h2', { text: isEdit ? 'Edit medicine' : opts.restockOf ? 'Buy again' : 'Add medicine' }),
      formSection('💊', 'Medicine', [
        field('Name', name),
        el('div', { class: 'field-row' }, [field('Type', type), field('Purpose', purpose)]),
        field('How to use', usage),
        field('For whom', who),
      ]),
      formSection('📅', 'Pack', [
        el('div', { class: 'field-row' }, [field('Expiry (month / year on the pack)', expiry), field('Bought on', bought)]),
        disposeOld ? el('label', { class: 'med-dispose-old' }, [disposeOld, el('span', { text: 'Dispose of the old pack (expiry ' + expiryLabel(opts.restockOf.expiry) + ')' })]) : null,
      ].filter(Boolean)),
    ]),
    el('div', { class: 'sheet-footer' }, [el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, btns)]),
  ]));
  if (!isEdit && !opts.restockOf) setTimeout(() => name.focus(), 50);
}
