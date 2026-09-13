// Health Check module - Medical records tracking
import { DB } from './db.js';
import { $, el, toast, openModal, closeModal, field } from './app.js';
import { todayISO, num } from './core.js';

let _healthPerson = null;

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

async function getHealthParams() {
  let params = await DB.all('healthParams').catch(() => []);
  if (!params.length) {
    await Promise.all(DEFAULT_HEALTH_PARAMS.map(p => DB.put('healthParams', p)));
    params = await DB.all('healthParams').catch(() => []);
  }
  return params;
}

function paramRangeLabel(param) {
  if (param.intervalType === 'range') return param.min + '-' + param.max;
  if (param.intervalType === 'below') return '<' + param.max;
  if (param.intervalType === 'above') return '>' + param.min;
  return '';
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

  const head = el('div', { class: 'hc-header' }, [
    el('div', { class: 'hc-avatar', text: person.emoji || '🧑' }),
    el('h2', { text: person.name }),
    el('button', { class: 'icon-btn', text: '⚙️', onclick: () => openHealthSettingsMenu() }),
  ]);

  const personTabs = el('div', { class: 'hc-tabs' },
    people.map(p => el('button', {
      class: 'hc-tab' + (_healthPerson === p.id ? ' active' : ''),
      text: (p.emoji ? p.emoji + ' ' : '') + p.name,
      onclick: () => { _healthPerson = p.id; renderHealthCheck(); }
    }))
  );

  const checks = await DB.all('healthChecks').catch(() => []);
  const personChecks = checks.filter(c => c.personId === _healthPerson).sort((a, b) => b.date.localeCompare(a.date));

  const fab = $('#healthAddBtn');
  fab.classList.remove('hidden');
  fab.onclick = () => openHealthCheckForm(person);

  host.appendChild(head);
  host.appendChild(personTabs);

  if (!personChecks.length) {
    host.appendChild(el('div', { class: 'hc-empty', text: 'No records yet. Tap the + button to add one.' }));
    return;
  }

  const params = await getHealthParams();
  const sections = el('div', {});
  params.forEach(p => {
    const entries = personChecks
      .filter(c => c.parameters && c.parameters[p.id] !== undefined && c.parameters[p.id] !== null && c.parameters[p.id] !== '')
      .map(c => ({ date: c.date, checkType: c.checkType, value: c.parameters[p.id] }));
    if (entries.length) sections.appendChild(renderParamSection(p, entries));
  });
  host.appendChild(sections);
}

function renderParamSection(param, entries) {
  const rows = entries.map(e => {
    const status = getParamStatus(e.value, param);
    return el('tr', {}, [
      el('td', { class: 'hc-row-date', text: e.date + (e.checkType ? ' · ' + e.checkType : '') }),
      el('td', { class: 'hc-row-value', text: e.value + (param.unit ? ' ' + param.unit : '') }),
      el('td', {}, [
        el('span', { class: 'hc-badge', style: 'background: ' + getStatusBg(status) + '; color: ' + getStatusColor(status) + ';', text: getStatusIcon(status) }),
      ]),
    ]);
  });

  const children = [
    el('div', { class: 'hc-card-head' }, [
      el('div', { class: 'hc-card-title', text: param.label + (param.unit ? ' (' + param.unit + ')' : '') }),
      el('div', { class: 'hc-card-range', text: paramRangeLabel(param) }),
    ]),
    el('table', { class: 'hc-rows' }, [
      el('tbody', {}, rows)
    ]),
  ];
  if (entries.length > 1) children.push(renderTrendGraph(param, entries));

  return el('div', { class: 'hc-card' }, children);
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

async function openHealthPeopleManager(activeTab) {
  const people = await DB.all('healthPeople').catch(() => []);
  const tab = activeTab || 'add';

  const tabs = renderManagerTabs(tab, 'Add', 'List', people.length, (next) => { closeModal(); openHealthPeopleManager(next); });

  const listBody = people.length
    ? el('div', {}, people.map(p => el('div', { class: 'hc-list-row' }, [
        el('div', { style: 'font-size: 1.3rem;', text: p.emoji || '🧑' }),
        el('div', { style: 'flex: 1;', text: p.name + (p.age ? ' · ' + p.age + 'y' : '') + (p.gender ? ' · ' + p.gender : '') }),
        el('button', {
          class: 'btn ghost', style: 'padding: 6px 10px;', text: 'Delete',
          onclick: async () => {
            if (!window.confirm('Delete ' + p.name + '? This also removes their health records.')) return;
            await DB.del('healthPeople', p.id);
            const checks = await DB.all('healthChecks').catch(() => []);
            await Promise.all(checks.filter(c => c.personId === p.id).map(c => DB.del('healthChecks', c.id)));
            closeModal(); toast('Removed'); openHealthPeopleManager('list');
          },
        }),
      ])))
    : el('div', { class: 'hc-list-empty', text: 'No one added yet.' });

  const emojiInput = el('input', { type: 'text', placeholder: '🧑', maxlength: '4', style: 'width: 60px; text-align: center; font-size: 1.2rem;' });
  const nameInput = el('input', { type: 'text', placeholder: 'Name' });
  const ageInput = el('input', { type: 'number', inputmode: 'numeric', placeholder: 'Age (optional)' });
  const genderInput = el('select', {}, [
    el('option', { value: '', text: 'Gender (optional)' }),
    el('option', { value: 'Male', text: 'Male' }),
    el('option', { value: 'Female', text: 'Female' }),
    el('option', { value: 'Other', text: 'Other' }),
  ]);

  const add = async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('Enter a name'); return; }
    await DB.put('healthPeople', { name, emoji: emojiInput.value.trim() || null, age: num(ageInput.value) || null, gender: genderInput.value || null });
    closeModal(); toast('Added'); openHealthPeopleManager('list');
  };

  const formBody = el('div', {}, [
    field('Name', nameInput),
    field('Emoji', emojiInput),
    field('Age', ageInput),
    field('Gender', genderInput),
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
          ? [el('button', { class: 'btn primary', text: '+ Add', onclick: add }), el('button', { class: 'btn ghost', text: 'Close', onclick: () => { closeModal(); renderHealthCheck(); } })]
          : [el('button', { class: 'btn ghost', text: 'Close', onclick: () => { closeModal(); renderHealthCheck(); } })]
      ),
    ]),
  ]));
}

async function openHealthParamsManager(activeTab) {
  const params = await getHealthParams();
  const tab = activeTab || 'add';

  const tabs = renderManagerTabs(tab, 'Add', 'List', params.length, (next) => { closeModal(); openHealthParamsManager(next); });

  const listBody = params.length
    ? el('div', {}, params.map(p => el('div', { class: 'hc-list-row' }, [
        el('div', { style: 'flex: 1;' }, [
          el('div', { style: 'font-weight: 600;', text: p.label + (p.unit ? ' (' + p.unit + ')' : '') }),
          el('div', { style: 'font-size: 0.8rem; color: var(--muted);', text: paramRangeLabel(p) }),
        ]),
        el('button', {
          class: 'btn ghost', style: 'padding: 6px 10px;', text: 'Delete',
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

  const syncFields = () => {
    minField.style.display = typeInput.value === 'below' ? 'none' : '';
    maxField.style.display = typeInput.value === 'above' ? 'none' : '';
  };
  typeInput.addEventListener('change', syncFields);
  syncFields();

  const add = async () => {
    const label = labelInput.value.trim();
    if (!label) { toast('Enter a parameter name'); return; }
    const intervalType = typeInput.value;
    const min = num(minInput.value);
    const max = num(maxInput.value);
    if (intervalType === 'range' && (min == null || max == null)) { toast('Enter both min and max'); return; }
    if (intervalType === 'below' && max == null) { toast('Enter the max limit'); return; }
    if (intervalType === 'above' && min == null) { toast('Enter the min limit'); return; }
    await DB.put('healthParams', { label, unit: unitInput.value.trim(), intervalType, min, max });
    closeModal(); toast('Added'); openHealthParamsManager('list');
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
          ? [el('button', { class: 'btn primary', text: '+ Add', onclick: add }), el('button', { class: 'btn ghost', text: 'Close', onclick: () => { closeModal(); renderHealthCheck(); } })]
          : [el('button', { class: 'btn ghost', text: 'Close', onclick: () => { closeModal(); renderHealthCheck(); } })]
      ),
    ]),
  ]));
}

async function openHealthCheckForm(person) {
  const params = await getHealthParams();

  const dateInput = el('input', { type: 'date', value: todayISO() });
  const checkTypeInput = el('input', { type: 'text', placeholder: 'e.g. Annual Physical, Quarterly Check' });
  const notesInput = el('textarea', { placeholder: 'Notes (optional)' });

  const paramInputs = {};
  const paramFields = params.map(p => {
    const input = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: paramRangeLabel(p) + (p.unit ? ' ' + p.unit : '') });
    paramInputs[p.id] = input;
    return field(p.label + (p.unit ? ' (' + p.unit + ')' : ''), input);
  });

  const save = async () => {
    const date = dateInput.value || todayISO();
    const parameters = {};
    params.forEach(p => {
      const v = paramInputs[p.id].value;
      if (v !== '' && v != null) parameters[p.id] = num(v);
    });
    if (!Object.keys(parameters).length) { toast('Enter at least one parameter'); return; }
    await DB.put('healthChecks', {
      personId: person.id,
      date,
      ym: date.slice(0, 7),
      checkType: checkTypeInput.value.trim(),
      notes: notesInput.value.trim(),
      parameters,
    });
    closeModal(); toast('Health check added'); renderHealthCheck();
  };

  openModal(el('div', { class: 'sheet has-fixed-footer' }, [
    el('div', { class: 'sheet-scroll' }, [
      el('h2', { text: 'Add Health Check' }),
      field('Date', dateInput),
      field('Check type', checkTypeInput),
      ...paramFields,
      field('Notes', notesInput),
    ]),
    el('div', { class: 'sheet-footer' }, [
      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
        el('button', { class: 'btn primary', text: 'Save', onclick: save }),
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: closeModal }),
      ]),
    ]),
  ]));
}

export { renderHealthCheck, openHealthPeopleManager, openHealthCheckForm, openHealthParamsManager };
