// Health Check module - Medical records tracking

let _healthPerson = null;
let _healthYear = new Date().getFullYear();

const HEALTH_PARAMS = [
  { key: 'fasting_sugar', label: 'Fasting Sugar', unit: 'mg/dL', range: '70-100' },
  { key: 'hba1c', label: 'HbA1c', unit: '%', range: '<5.7' },
  { key: 'ldl', label: 'LDL', unit: 'mg/dL', range: '<100' },
  { key: 'hdl', label: 'HDL', unit: 'mg/dL', range: '>40' },
  { key: 'bp_systolic', label: 'BP Systolic', unit: 'mmHg', range: '<120' },
  { key: 'bp_diastolic', label: 'BP Diastolic', unit: 'mmHg', range: '<80' },
  { key: 'triglycerides', label: 'Triglycerides', unit: 'mg/dL', range: '<150' },
];

async function renderHealthCheck() {
  const host = document.getElementById('healthView');
  if (!host) {
    console.error('healthView element not found');
    return;
  }
  host.innerHTML = '';

  try {
    const people = await DB.all('healthPeople').catch(() => []);
    if (!people.length) {
      host.innerHTML = '<div style="padding: 20px; text-align: center; color: #9fb0d4;">No people added. Tap the gear icon to add family members.</div>';
      return;
    }
  } catch (e) {
    console.error('Error loading health data:', e);
    host.innerHTML = '<div style="padding: 20px; text-align: center; color: #f87171;">Error loading health data. Please try again.</div>';
    return;
  }

  if (!_healthPerson) _healthPerson = people[0].id;
  const person = people.find(p => p.id === _healthPerson) || people[0];
  if (!person.id) _healthPerson = people[0].id;

  const head = el('div', { style: 'display: flex; gap: 12px; align-items: center; margin-bottom: 20px;' }, [
    el('h2', { style: 'margin: 0; flex: 1;', text: person.name }),
    el('button', { class: 'icon-btn', text: '⚙️', onclick: () => openHealthPeopleManager() }),
  ]);

  const personTabs = el('div', { style: 'display: flex; gap: 8px; margin-bottom: 16px; overflow-x: auto;' }, [
    ...people.map(p => el('button', {
      style: 'padding: 10px 16px; border-radius: 999px; border: 1px solid #28365e; background: ' + (_healthPerson === p.id ? '#38bdf8' : '#182441') + '; color: ' + (_healthPerson === p.id ? '#0e1726' : '#9fb0d4') + '; cursor: pointer; white-space: nowrap; font-weight: ' + (_healthPerson === p.id ? '600' : '400') + ';',
      text: p.name,
      onclick: () => { _healthPerson = p.id; renderHealthCheck(); }
    }))
  ]);

  const checks = await DB.all('healthChecks').catch(() => []);
  const personChecks = checks.filter(c => c.personId === _healthPerson && c.ym.slice(0, 4) === String(_healthYear)).sort((a, b) => b.date.localeCompare(a.date));

  const yearTabs = el('div', { style: 'display: flex; gap: 12px; margin-bottom: 16px;' }, [
    ...Array.from({length: 5}, (_, i) => {
      const y = new Date().getFullYear() - i;
      return el('button', {
        style: 'padding: 8px 12px; border: 1px solid #28365e; background: ' + (_healthYear === y ? '#38bdf8' : 'transparent') + '; color: ' + (_healthYear === y ? '#0e1726' : '#9fb0d4') + '; cursor: pointer; border-radius: 8px; font-weight: ' + (_healthYear === y ? '600' : '400') + ';',
        text: String(y),
        onclick: () => { _healthYear = y; renderHealthCheck(); }
      });
    }),
    el('button', { class: 'btn-add', style: 'margin-left: auto; padding: 8px 12px; background: #34d399; color: #0e1726; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;', text: '+ Add Check', onclick: () => openHealthCheckForm(person) })
  ]);

  host.appendChild(head);
  host.appendChild(personTabs);
  host.appendChild(yearTabs);

  if (!personChecks.length) {
    host.appendChild(el('div', { style: 'padding: 20px; color: #9fb0d4; text-align: center;', text: 'No records for ' + _healthYear }));
  } else {
    const recordsList = el('div', { style: 'display: flex; flex-direction: column; gap: 16px;' });
    personChecks.forEach(check => {
      recordsList.appendChild(renderHealthCheckCard(check, person));
    });
    host.appendChild(recordsList);
  }
}

function renderHealthCheckCard(check, person) {
  const params = check.parameters || {};
  const rows = HEALTH_PARAMS.filter(p => params[p.key] !== undefined).map(p => {
    const value = params[p.key];
    const status = getParamStatus(value, p);
    return el('tr', {}, [
      el('td', { style: 'padding: 8px; text-align: left;', text: p.label }),
      el('td', { style: 'padding: 8px; text-align: right; font-weight: 600;', text: value + (p.unit ? ' ' + p.unit : '') }),
      el('td', { style: 'padding: 8px; font-size: 0.75rem; color: #9fb0d4; text-align: right;', text: p.range }),
      el('td', { style: 'padding: 8px; text-align: center; font-weight: 600; border-radius: 6px; background: ' + getStatusBg(status) + '; color: ' + getStatusColor(status) + ';', text: getStatusIcon(status) }),
    ]);
  });

  return el('div', { style: 'background: #1f2d52; border: 1px solid #28365e; border-radius: 14px; padding: 16px;' }, [
    el('div', { style: 'font-size: 0.9rem; color: #9fb0d4; margin-bottom: 12px;', text: check.date + ' · ' + (check.checkType || 'Check') }),
    check.notes ? el('div', { style: 'font-size: 0.85rem; color: #9fb0d4; margin-bottom: 12px; font-style: italic;', text: check.notes }) : null,
    el('table', { style: 'width: 100%; border-collapse: collapse;' }, [
      el('tbody', {}, rows)
    ]),
  ]);
}

function getParamStatus(value, param) {
  const val = parseFloat(value);
  if (isNaN(val)) return 'unknown';

  if (param.range.includes('-')) {
    const [min, max] = param.range.split('-').map(parseFloat);
    if (val >= min && val <= max) return 'good';
    if (val < min) return 'low';
    return 'high';
  } else if (param.range.startsWith('<')) {
    const max = parseFloat(param.range.slice(1));
    return val < max ? 'good' : 'high';
  } else if (param.range.startsWith('>')) {
    const min = parseFloat(param.range.slice(1));
    return val > min ? 'good' : 'low';
  }
  return 'unknown';
}

function getStatusIcon(status) {
  return { good: '✓', high: '↑', low: '↓', unknown: '?' }[status] || '?';
}

function getStatusColor(status) {
  return { good: '#34d399', high: '#f87171', low: '#fbbf24', unknown: '#9fb0d4' }[status] || '#9fb0d4';
}

function getStatusBg(status) {
  return { good: 'rgba(52, 211, 153, 0.25)', high: 'rgba(248, 113, 113, 0.25)', low: 'rgba(251, 191, 36, 0.25)', unknown: 'transparent' }[status] || 'transparent';
}

function openHealthPeopleManager() {
  // TODO: People manager modal
  toast('People manager coming soon');
}

function openHealthCheckForm(person) {
  // TODO: Health check entry form
  toast('Add check form coming soon');
}

export { renderHealthCheck, openHealthPeopleManager, openHealthCheckForm };