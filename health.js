// Health Check module - Medical records tracking
import { DB } from './db.js';
import { $, el, toast, openModal, closeModal, field } from './app.js';
import { todayISO, num } from './core.js';

let _healthPerson = null;
// Which parameter card (by id) currently has its older readings expanded -
// a single value, not a set, so opening one accordion-style closes any
// other that was open.
let _expandedParamId = null;
// When on, only parameters whose LATEST reading is outside its reference
// range are listed - a parameter that has since returned to normal drops
// out even if an older reading was abnormal.
let _hcFilterOutOfRange = false;

// Seeded once, the first time the Health Check section is opened with no
// parameters yet defined - after that the user owns this list via the gear
// icon's "Parameters" option, so nothing here is read again.
const DEFAULT_HEALTH_PARAMS = [
  { label: 'Fasting Sugar', unit: 'mg/dL', intervalType: 'range', min: 70, max: 100 },
  { label: 'HbA1c', unit: '%', intervalType: 'below', max: 5.7 },
  { label: 'Total Cholesterol', unit: 'mg/dL', intervalType: 'below', max: 200 },
  { label: 'LDL', unit: 'mg/dL', intervalType: 'below', max: 100 },
  { label: 'HDL', unit: 'mg/dL', intervalType: 'above', min: 40 },
  { label: 'Triglycerides', unit: 'mg/dL', intervalType: 'below', max: 150 },
  { label: 'Haemoglobin', unit: 'g/dL', intervalType: 'range', min: 12, max: 16 },
  { label: 'BP Systolic', unit: 'mmHg', intervalType: 'range', min: 90, max: 120 },
  { label: 'BP Diastolic', unit: 'mmHg', intervalType: 'range', min: 60, max: 80 },
];

// Stored as a date of birth rather than a static age, so a person's avatar
// and any age display stay correct on their own as years pass instead of
// quietly going stale until someone reopens their record to bump a number.
function calcAge(dob) {
  if (!dob) return null;
  const b = new Date(dob);
  if (isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

// Age/gender -> avatar, so people aren't asked to pick their own emoji.
// Falls back to a neutral figure whenever either input is missing.
function personEmoji(age, gender) {
  const male = gender === 'Male';
  const female = gender === 'Female';
  if (age != null) {
    if (age < 3) return '👶';
    if (age < 13) return male ? '👦' : female ? '👧' : '🧒';
    if (age < 60) return male ? '👨' : female ? '👩' : '🧑';
    return male ? '👴' : female ? '👵' : '🧓';
  }
  return male ? '👨' : female ? '👩' : '🧑';
}

async function getHealthParams() {
  let params = await DB.all('healthParams').catch(() => []);
  if (!params.length) {
    await Promise.all(DEFAULT_HEALTH_PARAMS.map(p => DB.put('healthParams', p)));
    params = await DB.all('healthParams').catch(() => []);
  }
  return params;
}

// A saved check's parameters[id] is `{ value, medicineTaken }` as of the
// per-test medicine change, but older records (saved before that change)
// stored the raw number directly - normalize both shapes here so neither
// the listing nor the edit form silently drops pre-existing entries.
function normalizeParamEntry(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return { value: raw.value, medicineTaken: !!raw.medicineTaken };
  return { value: raw, medicineTaken: false };
}

function paramRangeLabel(param) {
  if (param.intervalType === 'range') return param.min + '-' + param.max;
  if (param.intervalType === 'below') return '<' + param.max;
  if (param.intervalType === 'above') return '>' + param.min;
  return '';
}

const CHECK_TYPES = ['Annual Check-up', 'Periodic Check-up'];
const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// One fixed color per calendar month, shared by every entry that falls in
// that month regardless of parameter or year - a quick visual "which month"
// cue when scanning a list of readings.
// Jan starts green, Dec ends blue, each month a small step along that one
// hue sweep rather than a full rainbow - close neighbors (e.g. Jun/Jul) read
// as similar, while Jan and Dec read as clearly different.
const MONTH_COLORS = Array.from({ length: 12 }, (_, i) => 'hsl(' + (150 + (220 - 150) * (i / 11)).toFixed(0) + ', 62%, 42%)');

// A small calendar-card chip (day + month on top, year underneath) used
// wherever a reading or a record's date is shown, instead of a plain
// "YYYY-MM-DD" string.
function calChip(dateStr) {
  const [y, m, d] = (dateStr || '').split('-');
  const mi = (parseInt(m, 10) || 1) - 1;
  return el('div', { class: 'hc-cal' }, [
    el('div', { class: 'hc-cal-top', style: 'background: ' + MONTH_COLORS[mi] + ';', text: (parseInt(d, 10) || '') + ' ' + MONTH_ABBR[mi] }),
    el('div', { class: 'hc-cal-year', text: y }),
  ]);
}

function checkTypeBadge(type) {
  if (!type) return null;
  const isAnnual = type === 'Annual Check-up';
  const short = isAnnual ? 'Annual' : type === 'Periodic Check-up' ? 'Periodic' : type;
  const color = isAnnual ? '#38bdf8' : '#34d399';
  return el('span', { class: 'hc-type-badge', style: 'background: ' + color + '22; color: ' + color + ';', text: short });
}

async function renderHealthCheck() {
  const host = document.getElementById('healthView');
  if (!host) {
    console.error('healthView element not found');
    return;
  }
  host.innerHTML = '';

  let people;
  try {
    people = await DB.all('healthPeople');
  } catch (e) {
    console.error('Error loading health data:', e);
    host.innerHTML = '<div class="hc-empty" style="color: var(--bad);">Error loading health data. Please try again.</div>';
    return;
  }

  if (!people.length) {
    $('#healthAddBtn').classList.add('hidden');
    host.appendChild(el('div', { class: 'hc-empty' }, [
      el('div', { text: 'No people added yet.' }),
      el('button', { class: 'hc-empty-cta', text: '+ Add Family Member', onclick: () => openHealthPeopleManager() }),
    ]));
    return;
  }

  if (!_healthPerson) _healthPerson = people[0].id;
  const person = people.find(p => p.id === _healthPerson) || people[0];
  if (!person.id) _healthPerson = people[0].id;

  const personTabs = el('div', { class: 'hc-tabs' },
    people.map(p => el('button', {
      class: 'hc-tab' + (_healthPerson === p.id ? ' active' : ''),
      text: p.name,
      onclick: () => { _healthPerson = p.id; renderHealthCheck(); }
    }))
  );

  // Badges on top with the gear pinned beside them (never under them) - the
  // tabs row fades out at its own trailing edge via a mask, so a long list
  // of people signals "there's more" without a hard cut against the gear.
  const topRow = el('div', { class: 'hc-toprow' }, [
    el('div', { class: 'hc-tabs-wrap' }, [personTabs]),
    el('button', { class: 'icon-btn hc-gear', text: '⚙️', onclick: () => openHealthSettingsMenu() }),
  ]);

  const age = calcAge(person.dob);
  const selected = el('div', { class: 'hc-selected' }, [
    el('div', { class: 'hc-avatar', text: personEmoji(age, person.gender) }),
    el('div', { style: 'flex: 1;' }, [
      el('div', { class: 'hc-selected-name', text: person.name }),
      age != null ? el('div', { class: 'hc-selected-age', text: age + 'y' }) : null,
    ].filter(Boolean)),
    el('button', {
      class: 'hc-filter-btn' + (_hcFilterOutOfRange ? ' active' : ''),
      text: 'Out of Range',
      onclick: () => { _hcFilterOutOfRange = !_hcFilterOutOfRange; renderHealthCheck(); },
    }),
  ]);

  const checks = await DB.all('healthChecks').catch(() => []);
  const personChecks = checks.filter(c => c.personId === _healthPerson).sort((a, b) => b.date.localeCompare(a.date));

  const fab = $('#healthAddBtn');
  fab.classList.remove('hidden');
  fab.onclick = () => openHealthCheckForm(person);

  host.appendChild(topRow);
  host.appendChild(selected);

  if (!personChecks.length) {
    host.appendChild(el('div', { class: 'hc-empty', text: 'No records yet. Tap the + button to add one.' }));
    return;
  }

  const params = (await getHealthParams()).slice().sort((a, b) => a.label.localeCompare(b.label));
  const sections = el('div', {});
  let shown = 0;
  params.forEach(p => {
    const entries = personChecks
      .map(c => { const n = c.parameters && normalizeParamEntry(c.parameters[p.id]); return n && n.value != null && n.value !== '' ? { date: c.date, checkType: c.checkType, value: n.value, lab: c.lab, medicineTaken: n.medicineTaken } : null; })
      .filter(Boolean);
    if (!entries.length) return;
    if (_hcFilterOutOfRange && getParamStatus(entries[0].value, p) === 'good') return;
    shown++;
    sections.appendChild(renderParamSection(p, entries));
  });
  if (_hcFilterOutOfRange && !shown) {
    sections.appendChild(el('div', { class: 'hc-empty', text: 'Nothing out of range for the latest check of each parameter.' }));
  }
  host.appendChild(sections);
}

// entries is newest-first. Only the latest reading shows by default; tapping
// it expands the rest in place, as one continuous list with no separate
// "N more"/"Hide" row - only a small caption under the latest row's status
// icon while collapsed. Only one parameter is expanded at a time: expanding
// another closes this one, since they all share _expandedParamId.
function renderParamSection(param, entries) {
  const [latest, ...older] = entries;
  const isExpanded = _expandedParamId === param.id;

  // renderHealthCheck() rebuilds the whole view, which otherwise leaves the
  // page at the top - restore the scroll position once the rebuild (and its
  // awaited DB reads) finish, so expanding/collapsing an entry doesn't yank
  // the page away from where the tap happened.
  const toggle = () => {
    const y = window.scrollY;
    _expandedParamId = isExpanded ? null : param.id;
    renderHealthCheck().then(() => window.scrollTo(0, y));
  };

  const children = [
    el('div', { class: 'hc-card-head' }, [
      el('div', { class: 'hc-card-title', text: param.label + (param.unit ? ' (' + param.unit + ')' : '') }),
      el('div', { class: 'hc-card-range', text: paramRangeLabel(param) }),
    ]),
    renderEntryRow(latest, param, {
      onClick: older.length ? toggle : null,
      moreCount: (!isExpanded && older.length) ? older.length : 0,
    }),
  ];

  if (isExpanded) older.forEach(e => children.push(renderEntryRow(e, param)));

  if (entries.length > 1) children.push(renderTrendGraph(param, entries));

  return el('div', { class: 'hc-card' }, children);
}

function renderEntryRow(entry, param, opts) {
  opts = opts || {};
  const status = getParamStatus(entry.value, param);
  const statusCol = [
    el('span', { class: 'hc-badge', style: 'background: ' + getStatusBg(status) + '; color: ' + getStatusColor(status) + ';', text: getStatusIcon(status) }),
    opts.moreCount ? el('div', { class: 'hc-more-caption', text: opts.moreCount + ' more' }) : null,
  ].filter(Boolean);

  // Check type sits on its own line beside the date; the lab (plus a pill
  // if medicine was on board for this specific reading) sits on the line
  // below it, rather than all three crowding one row.
  const meta = [
    checkTypeBadge(entry.checkType),
    (entry.lab || entry.medicineTaken) ? el('div', { class: 'hc-entry-sub' }, [
      entry.lab ? el('span', { class: 'hc-lab-tag', text: entry.lab }) : null,
      entry.medicineTaken ? el('span', { class: 'hc-med-pill', title: 'Medicine taken for this test', text: '💊' }) : null,
    ].filter(Boolean)) : null,
  ].filter(Boolean);

  const row = el('div', { class: 'hc-entry-row' + (opts.onClick ? ' clickable' : '') }, [
    calChip(entry.date),
    el('div', { class: 'hc-entry-meta' }, meta),
    el('div', { class: 'hc-entry-value', text: entry.value + (param.unit ? ' ' + param.unit : '') }),
    el('div', { class: 'hc-entry-status' }, statusCol),
  ]);
  if (opts.onClick) row.addEventListener('click', opts.onClick);
  return row;
}

// A small bar-per-reading trend strip, oldest to newest left-to-right so the
// bars read the same direction time does. Bar height reflects the value's
// position within this parameter's own min/max seen so far (not the healthy
// range) - the goal is "is it moving", not a second copy of the status color,
// which each bar also carries via its fill.
function renderTrendGraph(param, entries) {
  const chrono = entries.slice().reverse();
  const values = chrono.map(e => parseFloat(e.value)).filter(v => !isNaN(v));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;

  const bars = chrono.map(e => {
    const v = parseFloat(e.value);
    const pct = isNaN(v) ? 5 : 10 + ((v - lo) / span) * 85;
    const status = getParamStatus(e.value, param);
    return el('div', {
      class: 'hc-trend-bar',
      title: e.date + ': ' + e.value + (param.unit ? ' ' + param.unit : ''),
      style: 'height: ' + pct.toFixed(0) + '%; background: ' + getStatusColor(status) + ';',
    });
  });

  return el('div', { class: 'hc-trend' }, bars);
}

function getParamStatus(value, param) {
  const val = parseFloat(value);
  if (isNaN(val)) return 'unknown';

  if (param.intervalType === 'range') {
    if (val >= param.min && val <= param.max) return 'good';
    if (val < param.min) return 'low';
    return 'high';
  } else if (param.intervalType === 'below') {
    return val < param.max ? 'good' : 'high';
  } else if (param.intervalType === 'above') {
    return val > param.min ? 'good' : 'low';
  }
  return 'unknown';
}

function getStatusIcon(status) {
  return { good: '✓', high: '↑', low: '↓', unknown: '?' }[status] || '?';
}

function getStatusColor(status) {
  return { good: '#34d399', high: '#f87171', low: '#fbbf24', unknown: 'var(--muted)' }[status] || 'var(--muted)';
}

function getStatusBg(status) {
  return { good: 'rgba(52, 211, 153, 0.2)', high: 'rgba(248, 113, 113, 0.2)', low: 'rgba(251, 191, 36, 0.2)', unknown: 'transparent' }[status] || 'transparent';
}

// Gear icon -> a small action sheet offering the two things it manages:
// who is tracked (Family Members) and what is tracked (Parameters).
function openHealthSettingsMenu() {
  openModal(el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet-scroll' }, [
      el('h2', { text: 'Health Check Settings' }),
      el('button', { class: 'hc-settings-btn', onclick: () => openHealthPeopleManager() }, [
        el('span', { class: 'hc-settings-icon', text: '👤' }), 'Family Members',
      ]),
      el('button', { class: 'hc-settings-btn', onclick: () => openHealthParamsManager() }, [
        el('span', { class: 'hc-settings-icon', text: '📊' }), 'Parameters',
      ]),
    ]),
  ]));
}

// Shared by both manager modals: an "Add" tab (the default, since adding is
// the more frequent action) and a "List (N)" tab holding the existing set,
// so the form doesn't compete with a long list for scroll space.
function renderManagerTabs(activeKey, addLabel, listLabel, listCount, onSwitch) {
  return el('div', { class: 'hc-mgr-tabs' }, [
    el('button', { class: 'hc-mgr-tab' + (activeKey === 'add' ? ' active' : ''), text: addLabel, onclick: () => onSwitch('add') }),
    el('button', { class: 'hc-mgr-tab' + (activeKey === 'list' ? ' active' : ''), text: listLabel + ' (' + listCount + ')', onclick: () => onSwitch('list') }),
  ]);
}

async function openHealthPeopleManager(activeTab, editing) {
  const people = await DB.all('healthPeople').catch(() => []);
  const tab = activeTab || 'add';
  const isEdit = !!editing;

  const tabs = renderManagerTabs(tab, isEdit ? 'Edit' : 'Add', 'List', people.length, (next) => { closeModal(); openHealthPeopleManager(next); });

  const listBody = people.length
    ? el('div', {}, people.map(p => {
        const age = calcAge(p.dob);
        return el('div', { class: 'hc-list-row' }, [
          el('div', { style: 'font-size: 1.3rem;', text: personEmoji(age, p.gender) }),
          el('div', { style: 'flex: 1;', text: p.name + (age != null ? ' · ' + age + 'y' : '') + (p.gender ? ' · ' + p.gender : '') }),
          el('button', { class: 'hc-icon-btn', 'aria-label': 'Health records', title: 'Health records', text: '📋', onclick: () => { closeModal(); openHealthRecordsManager(p); } }),
          el('button', { class: 'hc-icon-btn', 'aria-label': 'Edit', title: 'Edit', text: '✏️', onclick: () => { closeModal(); openHealthPeopleManager('add', p); } }),
          el('button', {
            class: 'hc-icon-btn danger', 'aria-label': 'Delete', title: 'Delete', text: '🗑️',
            onclick: async () => {
              if (!window.confirm('Delete ' + p.name + '? This also removes their health records.')) return;
              await DB.del('healthPeople', p.id);
              const checks = await DB.all('healthChecks').catch(() => []);
              await Promise.all(checks.filter(c => c.personId === p.id).map(c => DB.del('healthChecks', c.id)));
              closeModal(); toast('Removed'); openHealthPeopleManager('list');
            },
          }),
        ]);
      }))
    : el('div', { class: 'hc-list-empty', text: 'No one added yet.' });

  const nameInput = el('input', { type: 'text', placeholder: 'Name' });
  const dobInput = el('input', { type: 'date', max: todayISO() });
  let gender = (isEdit && editing.gender) || null;

  const avatarPreview = el('div', { style: 'width: 48px; height: 48px; border-radius: 50%; background: var(--card); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; font-size: 1.6rem;' });
  const paintAvatar = () => { avatarPreview.textContent = personEmoji(calcAge(dobInput.value), gender); };

  const maleBtn = el('button', { type: 'button', text: '👨 Male', onclick: () => { gender = 'Male'; paintGender(); paintAvatar(); } });
  const femaleBtn = el('button', { type: 'button', text: '👩 Female', onclick: () => { gender = 'Female'; paintGender(); paintAvatar(); } });
  const paintGender = () => {
    maleBtn.className = 'btn' + (gender === 'Male' ? ' primary' : ' ghost');
    femaleBtn.className = 'btn' + (gender === 'Female' ? ' primary' : ' ghost');
  };
  paintGender();

  if (isEdit) { nameInput.value = editing.name || ''; dobInput.value = editing.dob || ''; }
  paintAvatar();
  // Some mobile browsers only fire 'change' (not 'input') once a date is
  // picked via the native picker UI, so both are wired to be sure the
  // avatar preview actually updates.
  dobInput.addEventListener('input', paintAvatar);
  dobInput.addEventListener('change', paintAvatar);

  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('Enter a name'); return; }
    const rec = { name, dob: dobInput.value || null, gender };
    if (isEdit) rec.id = editing.id;
    await DB.put('healthPeople', rec);
    closeModal(); toast(isEdit ? 'Updated' : 'Added'); openHealthPeopleManager('list');
  };

  const formBody = el('div', {}, [
    el('div', { style: 'display: flex; justify-content: center; margin-bottom: 16px;' }, [avatarPreview]),
    field('Name', nameInput),
    field('Date of birth', dobInput),
    field('Gender', el('div', { style: 'display: flex; gap: 8px;' }, [maleBtn, femaleBtn])),
  ]);

  openModal(el('div', { class: 'sheet has-fixed-footer' }, [
    el('div', { class: 'sheet-scroll' }, [
      el('h2', { text: 'Family Members' }),
      tabs,
      tab === 'add' ? formBody : listBody,
    ]),
    el('div', { class: 'sheet-footer' }, [
      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' },
        tab === 'add'
          ? [el('button', { class: 'btn primary', text: isEdit ? 'Save' : '+ Add', onclick: save }), el('button', { class: 'btn ghost', text: 'Close', onclick: () => { closeModal(); renderHealthCheck(); } })]
          : [el('button', { class: 'btn ghost', text: 'Close', onclick: () => { closeModal(); renderHealthCheck(); } })]
      ),
    ]),
  ]));
}

async function openHealthParamsManager(activeTab, editing) {
  const params = (await getHealthParams()).slice().sort((a, b) => a.label.localeCompare(b.label));
  const tab = activeTab || 'add';
  const isEdit = !!editing;

  const tabs = renderManagerTabs(tab, isEdit ? 'Edit' : 'Add', 'List', params.length, (next) => { closeModal(); openHealthParamsManager(next); });

  const listBody = params.length
    ? el('div', {}, params.map(p => el('div', { class: 'hc-list-row' }, [
        el('div', { style: 'flex: 1;' }, [
          el('div', { style: 'font-weight: 600;', text: p.label + (p.unit ? ' (' + p.unit + ')' : '') }),
          el('div', { style: 'font-size: 0.8rem; color: var(--muted);', text: paramRangeLabel(p) }),
        ]),
        el('button', { class: 'hc-icon-btn', 'aria-label': 'Edit', title: 'Edit', text: '✏️', onclick: () => { closeModal(); openHealthParamsManager('add', p); } }),
        el('button', {
          class: 'hc-icon-btn danger', 'aria-label': 'Delete', title: 'Delete', text: '🗑️',
          onclick: async () => {
            if (!window.confirm('Delete parameter "' + p.label + '"? Past readings for it are kept but will no longer show a status color.')) return;
            await DB.del('healthParams', p.id);
            closeModal(); toast('Removed'); openHealthParamsManager('list');
          },
        }),
      ])))
    : el('div', { class: 'hc-list-empty', text: 'No parameters yet.' });

  const labelInput = el('input', { type: 'text', placeholder: 'e.g. Vitamin D' });
  const unitInput = el('input', { type: 'text', placeholder: 'e.g. ng/mL' });
  const typeInput = el('select', {}, [
    el('option', { value: 'range', text: 'Range (min - max)' }),
    el('option', { value: 'below', text: 'Below a limit (< max)' }),
    el('option', { value: 'above', text: 'Above a limit (> min)' }),
  ]);
  const minInput = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'Min' });
  const maxInput = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'Max' });
  const minField = field('Min', minInput);
  const maxField = field('Max', maxInput);
  if (isEdit) {
    labelInput.value = editing.label || '';
    unitInput.value = editing.unit || '';
    typeInput.value = editing.intervalType || 'range';
    minInput.value = editing.min != null ? editing.min : '';
    maxInput.value = editing.max != null ? editing.max : '';
  }

  const syncFields = () => {
    minField.style.display = typeInput.value === 'below' ? 'none' : '';
    maxField.style.display = typeInput.value === 'above' ? 'none' : '';
  };
  typeInput.addEventListener('change', syncFields);
  syncFields();

  const save = async () => {
    const label = labelInput.value.trim();
    if (!label) { toast('Enter a parameter name'); return; }
    const intervalType = typeInput.value;
    const min = num(minInput.value);
    const max = num(maxInput.value);
    if (intervalType === 'range' && (min == null || max == null)) { toast('Enter both min and max'); return; }
    if (intervalType === 'below' && max == null) { toast('Enter the max limit'); return; }
    if (intervalType === 'above' && min == null) { toast('Enter the min limit'); return; }
    const rec = { label, unit: unitInput.value.trim(), intervalType, min, max };
    if (isEdit) rec.id = editing.id;
    await DB.put('healthParams', rec);
    closeModal(); toast(isEdit ? 'Updated' : 'Added'); openHealthParamsManager('list');
  };

  const formBody = el('div', {}, [
    field('Name', labelInput),
    field('Unit', unitInput),
    field('Type', typeInput),
    minField,
    maxField,
  ]);

  openModal(el('div', { class: 'sheet has-fixed-footer' }, [
    el('div', { class: 'sheet-scroll' }, [
      el('h2', { text: 'Parameters' }),
      tabs,
      tab === 'add' ? formBody : listBody,
    ]),
    el('div', { class: 'sheet-footer' }, [
      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' },
        tab === 'add'
          ? [el('button', { class: 'btn primary', text: isEdit ? 'Save' : '+ Add', onclick: save }), el('button', { class: 'btn ghost', text: 'Close', onclick: () => { closeModal(); renderHealthCheck(); } })]
          : [el('button', { class: 'btn ghost', text: 'Close', onclick: () => { closeModal(); renderHealthCheck(); } })]
      ),
    ]),
  ]));
}

async function openHealthCheckForm(person, existing) {
  const params = await getHealthParams();
  const isEdit = !!existing;

  const dateInput = el('input', { type: 'date', value: (isEdit && existing.date) || todayISO() });
  const checkTypeInput = el('select', {}, [
    el('option', { value: '', text: 'Select check type' }),
    ...CHECK_TYPES.map(t => el('option', { value: t, text: t })),
  ]);
  if (isEdit) checkTypeInput.value = existing.checkType || '';
  const labInput = el('input', { type: 'text', placeholder: 'e.g. SRL Diagnostics' });
  if (isEdit) labInput.value = existing.lab || '';
  const notesInput = el('textarea', { placeholder: 'Notes (optional)' });
  if (isEdit) notesInput.value = existing.notes || '';

  // Whether medicine was on board varies test to test (e.g. a fasting
  // panel vs one taken alongside a regular dose), so it's asked per
  // parameter rather than once for the whole visit.
  const paramInputs = {};
  const paramMedInputs = {};
  const paramFields = params.map(p => {
    const existingP = isEdit && existing.parameters && normalizeParamEntry(existing.parameters[p.id]);
    const input = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: paramRangeLabel(p) + (p.unit ? ' ' + p.unit : '') });
    if (existingP && existingP.value != null) input.value = existingP.value;
    const medInput = el('input', { type: 'checkbox' });
    if (existingP) medInput.checked = !!existingP.medicineTaken;
    paramInputs[p.id] = input;
    paramMedInputs[p.id] = medInput;
    // Value on the left half, medicine toggle on the right - .field-row's
    // existing 50/50 flex split (used elsewhere in the app) does the work;
    // the checkbox side just needs to match the value field's height and
    // sit at its bottom so the two line up beside each other.
    const medWrap = el('div', { style: 'flex: 1; display: flex; flex-direction: column; justify-content: flex-end;' }, [
      el('label', { style: 'display: flex; align-items: center; gap: 8px; padding-bottom: 12px; font-size: 0.85rem; color: var(--muted); cursor: pointer;' }, [medInput, '💊 Medicine taken']),
    ]);
    return el('div', { class: 'field-row' }, [
      field(p.label + (p.unit ? ' (' + p.unit + ')' : ''), input),
      medWrap,
    ]);
  });

  const save = async () => {
    const date = dateInput.value || todayISO();
    const parameters = {};
    params.forEach(p => {
      const v = paramInputs[p.id].value;
      if (v !== '' && v != null) parameters[p.id] = { value: num(v), medicineTaken: paramMedInputs[p.id].checked };
    });
    if (!Object.keys(parameters).length) { toast('Enter at least one parameter'); return; }
    const rec = {
      personId: person.id,
      date,
      ym: date.slice(0, 7),
      checkType: checkTypeInput.value,
      lab: labInput.value.trim(),
      notes: notesInput.value.trim(),
      parameters,
    };
    if (isEdit) rec.id = existing.id;
    await DB.put('healthChecks', rec);
    closeModal(); toast(isEdit ? 'Health check updated' : 'Health check added'); renderHealthCheck();
  };

  const del = async () => {
    if (!window.confirm('Delete this health check record?')) return;
    await DB.del('healthChecks', existing.id);
    closeModal(); toast('Removed'); renderHealthCheck();
  };

  const footerBtns = [el('button', { class: 'btn primary', text: 'Save', onclick: save })];
  if (isEdit) footerBtns.push(el('button', { class: 'btn danger', text: 'Delete', onclick: del }));
  footerBtns.push(el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }));

  openModal(el('div', { class: 'sheet has-fixed-footer' }, [
    el('div', { class: 'sheet-scroll' }, [
      el('h2', { text: isEdit ? 'Edit Health Check' : 'Add Health Check' }),
      field('Date', dateInput),
      field('Check type', checkTypeInput),
      field('Lab', labInput),
      ...paramFields,
      field('Notes', notesInput),
    ]),
    el('div', { class: 'sheet-footer' }, [
      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, footerBtns),
    ]),
  ]));
}

// Reached from a person's row in Family Members (a small "records" icon) -
// every health check for that person, newest first, each editable or
// removable directly rather than only ever addable through the FAB.
async function openHealthRecordsManager(person) {
  const checks = await DB.all('healthChecks').catch(() => []);
  const personChecks = checks.filter(c => c.personId === person.id).sort((a, b) => b.date.localeCompare(a.date));

  const listBody = personChecks.length
    ? el('div', {}, personChecks.map(c => el('div', { class: 'hc-list-row' }, [
        calChip(c.date),
        el('div', { style: 'flex: 1;' }, [
          el('div', { style: 'font-weight: 600;', text: c.checkType || 'Check' }),
          el('div', { style: 'font-size: 0.8rem; color: var(--muted);', text: Object.keys(c.parameters || {}).length + ' parameter(s) recorded' }),
        ]),
        el('button', { class: 'hc-icon-btn', 'aria-label': 'Edit', title: 'Edit', text: '✏️', onclick: () => { closeModal(); openHealthCheckForm(person, c); } }),
        el('button', {
          class: 'hc-icon-btn danger', 'aria-label': 'Delete', title: 'Delete', text: '🗑️',
          onclick: async () => {
            if (!window.confirm('Delete this health check record from ' + c.date + '?')) return;
            await DB.del('healthChecks', c.id);
            closeModal(); toast('Removed'); openHealthRecordsManager(person);
          },
        }),
      ])))
    : el('div', { class: 'hc-list-empty', text: 'No records yet.' });

  openModal(el('div', { class: 'sheet has-fixed-footer' }, [
    el('div', { class: 'sheet-scroll' }, [
      el('h2', { text: person.name + '’s Records' }),
      listBody,
    ]),
    el('div', { class: 'sheet-footer' }, [
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn ghost', text: 'Close', onclick: () => { closeModal(); renderHealthCheck(); } }),
      ]),
    ]),
  ]));
}

export { renderHealthCheck, openHealthPeopleManager, openHealthCheckForm, openHealthParamsManager, openHealthRecordsManager };
