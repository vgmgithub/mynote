// Health Check module - Medical records tracking
import { DB } from './db.js';
import { $, el, toast, openModal, closeModal, field, flashSwipeDirection, insideHorizontalScroller } from './app.js';
import { todayISO, num } from './core.js';

let _healthPerson = null;
// 'family' shows the whole-family comparison table instead of one person's
// records; null/falsy is the normal per-person view keyed by _healthPerson.
let _hcView = null;
// Which parameter card (by id) currently has its older readings expanded -
// a single value, not a set, so opening one accordion-style closes any
// other that was open.
let _expandedParamId = null;
// When on, only parameters whose LATEST reading is outside its reference
// range are listed - a parameter that has since returned to normal drops
// out even if an older reading was abnormal.
let _hcFilterOutOfRange = false;
// installHealthSwipe() attaches its touch listeners once, the first time
// Health Check renders - not once per render, since renderHealthCheck()
// clears and rebuilds #healthView's children but never the element itself.
let _healthSwipeInstalled = false;

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

// Standard WHO adult bands (this app has no child-growth-chart data, so no
// paediatric BMI adjustment is attempted). Returns null unless BOTH height
// and weight are on record - a BMI computed from a guessed half of the pair
// would be worse than not showing one at all.
//
// `deltaKg` is how many kilograms at THIS height would land exactly on the
// nearer edge of the healthy band (18.5-24.9) - "how much", not just "which
// band" - `null`/`deltaDir: null` once already inside it, since there is
// nothing to move toward.
function calcBmi(heightCm, weightKg) {
  const h = Number(heightCm), w = Number(weightKg);
  if (!(h > 0) || !(w > 0)) return null;
  const m = h / 100;
  const bmi = w / (m * m);
  let category, cls;
  if (bmi < 18.5) { category = 'Underweight'; cls = 'low'; }
  else if (bmi < 25) { category = 'Healthy'; cls = 'good'; }
  else if (bmi < 30) { category = 'Overweight'; cls = 'high'; }
  else { category = 'Obese'; cls = 'high'; }
  let deltaKg = null, deltaDir = null;
  if (bmi < 18.5) { deltaKg = Math.round((18.5 * m * m) - w); deltaDir = 'gain'; }
  else if (bmi >= 25) { deltaKg = Math.round(w - (24.9 * m * m)); deltaDir = 'lose'; }
  return { bmi: Math.round(bmi * 10) / 10, category, cls, deltaKg, deltaDir };
}

// Age/gender -> avatar, so people aren't asked to pick their own emoji.
// Five brackets (baby 0-4, child 5-12, teen 13-24, adult 25-50, old 51+),
// each split Male/Female - ten fixed assets, no neutral fallback, so an
// unset gender defaults to the male half of whichever bracket the age
// falls in (matching the app's earlier default before this became
// gender-specific). Returns an asset key (icons/emoji/<key>.svg) rather
// than a Unicode character - system emoji fonts render the same character
// differently on every device, so a bundled, medium-skin-toned set is used
// instead, to look the same everywhere rather than however each device's
// own emoji font happens to draw it.
const AVATAR_MALE = { baby: 'baby-boy', child: 'child-boy', teen: 'teen-boy', adult: 'adult-man', old: 'old-man' };
const AVATAR_FEMALE = { baby: 'baby-girl', child: 'child-girl', teen: 'teen-girl', adult: 'adult-woman', old: 'old-woman' };
function personAvatarKey(age, gender) {
  let bracket;
  if (age == null) bracket = 'adult';
  else if (age <= 4) bracket = 'baby';
  else if (age <= 12) bracket = 'child';
  else if (age <= 24) bracket = 'teen';
  else if (age <= 50) bracket = 'adult';
  else bracket = 'old';
  return gender === 'Female' ? AVATAR_FEMALE[bracket] : AVATAR_MALE[bracket];
}

function avatarImg(key, size) {
  return el('img', { src: 'icons/emoji/' + key + '.svg', alt: '', style: 'width: ' + (size || '1em') + '; height: ' + (size || '1em') + '; display: inline-block; vertical-align: middle; flex-shrink: 0;' });
}

function personAvatarImg(age, gender, size) {
  return avatarImg(personAvatarKey(age, gender), size);
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
  if (param.intervalType === 'range') return (param.min != null && param.max != null) ? (param.min + '-' + param.max) : '—';
  if (param.intervalType === 'below') return param.max != null ? '<' + param.max : '—';
  if (param.intervalType === 'above') return param.min != null ? '>' + param.min : '—';
  return '';
}

// A param normally carries one reference range (intervalType/min/max) at
// its top level - old records only ever have that, and this returns the
// param itself unchanged for them. A param can optionally add a Male and/or
// Female override (same intervalType, different numbers); when one exists
// for the given gender this returns a range-shaped object built from it
// instead, otherwise it falls straight back to the param's own range.
function effectiveRange(param, gender) {
  if (param.genderSpecific) {
    if (gender === 'Male' && (param.maleMin != null || param.maleMax != null)) {
      return { intervalType: param.intervalType, min: param.maleMin, max: param.maleMax };
    }
    if (gender === 'Female' && (param.femaleMin != null || param.femaleMax != null)) {
      return { intervalType: param.intervalType, min: param.femaleMin, max: param.femaleMax };
    }
  }
  return param;
}

// "Standard interval" text for the (i) icon beside a parameter's name in
// the Add/Edit Health Check form - the same range the value input's own
// placeholder shows (effectiveRange resolves Male/Female first), just
// still available once something's typed and the placeholder is gone.
function paramIntervalText(p, gender) {
  const label = paramRangeLabel(effectiveRange(p, gender));
  return p.label + ': ' + (label && label !== '—' ? label + (p.unit ? ' ' + p.unit : '') : 'no standard range set');
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

// Swipe left/right anywhere on the Health Check content to step through the
// same strip as the person-tabs row (Family, then each person in tab order) -
// so switching who you're looking at doesn't need a reach up to the tabs.
// Touch-only, same thresholds as the Stocks portfolio swipe (installPortfolioSwipe
// in app.js) so the gesture feels consistent app-wide.
function installHealthSwipe() {
  if (_healthSwipeInstalled) return;
  _healthSwipeInstalled = true;
  const host = document.getElementById('healthView');
  if (!host) return;
  let sx = 0, sy = 0, st = 0, live = false;
  const SWIPE_MIN_X = 55, SWIPE_OFF_AXIS = 0.6, SWIPE_MAX_MS = 700;

  host.addEventListener('touchstart', (e) => {
    live = e.touches.length === 1 && !insideHorizontalScroller(e.target, host);
    if (!live) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
  }, { passive: true });
  host.addEventListener('touchcancel', () => { live = false; }, { passive: true });

  host.addEventListener('touchend', async (e) => {
    if (!live) return;
    live = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Date.now() - st > SWIPE_MAX_MS) return;
    if (Math.abs(dx) < SWIPE_MIN_X) return;
    if (Math.abs(dy) > Math.abs(dx) * SWIPE_OFF_AXIS) return;
    const dir = dx < 0 ? 1 : -1;

    const people = await DB.all('healthPeople').catch(() => []);
    if (!people.length) return;
    const stripIds = ['family', ...people.map(p => p.id)];
    const curId = _hcView === 'family' ? 'family' : _healthPerson;
    const idx = stripIds.indexOf(curId);
    if (idx === -1) return;
    const nextId = stripIds[idx + dir];
    if (nextId === undefined) return; // clamp at both ends, same as the portfolio swipe
    if (nextId === 'family') { _hcView = 'family'; } else { _hcView = null; _healthPerson = nextId; }
    await renderHealthCheck();
    flashSwipeDirection(dir);
    const activeTab = document.querySelector('.hc-tab.active');
    if (activeTab) activeTab.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, { passive: true });
}

async function renderHealthCheck() {
  const host = document.getElementById('healthView');
  if (!host) {
    console.error('healthView element not found');
    return;
  }
  installHealthSwipe();
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
      el('button', { class: 'hc-empty-cta', text: '+ Add Family Member', onclick: () => openHealthPeopleManager('add') }),
    ]));
    return;
  }

  if (!_healthPerson) _healthPerson = people[0].id;
  const person = people.find(p => p.id === _healthPerson) || people[0];
  if (!person.id) _healthPerson = people[0].id;

  // renderHealthCheck() rebuilds this whole row from scratch, so a fresh
  // .hc-tabs always starts scrolled to its left edge - without restoring
  // it, picking a person scrolled out of view snaps the row straight back
  // to the first badge on every tap instead of staying where it was.
  const selectTab = (setState) => {
    const sx = personTabs.scrollLeft;
    setState();
    renderHealthCheck().then(() => { const t = document.querySelector('.hc-tabs'); if (t) t.scrollLeft = sx; });
  };
  const personTabs = el('div', { class: 'hc-tabs' }, [
    el('button', {
      class: 'hc-tab hc-tab-family' + (_hcView === 'family' ? ' active' : ''),
      // Short on the tab itself - it sits beside a row of first names, and
      // "Family Health" repeated there read as a second copy of the page's
      // own title. The full "Family Health of N members" phrasing stays on
      // the selected-row below once this tab is actually open.
      text: 'Family',
      onclick: () => selectTab(() => { _hcView = 'family'; }),
    }),
    ...people.map(p => el('button', {
      class: 'hc-tab' + (_hcView !== 'family' && _healthPerson === p.id ? ' active' : ''),
      text: p.name,
      onclick: () => selectTab(() => { _hcView = null; _healthPerson = p.id; })
    })),
  ]);

  // Badges on top with the gear pinned beside them (never under them) - the
  // tabs row fades out at its own trailing edge via a mask, so a long list
  // of people signals "there's more" without a hard cut against the gear.
  const topRow = el('div', { class: 'hc-toprow' }, [
    el('div', { class: 'hc-tabs-wrap' }, [personTabs]),
    el('button', { class: 'icon-btn hc-gear gear-btn', text: '⚙️', onclick: () => openHealthSettingsMenu() }),
  ]);
  host.appendChild(topRow);

  const fab = $('#healthAddBtn');
  const isFamily = _hcView === 'family';
  const age = isFamily ? null : calcAge(person.dob);

  // Fetched here (rather than down with the section-building loop below,
  // where this used to live) so the Out of Range button's own count badge
  // can be computed before that button is built. Reused there too, so this
  // isn't a second DB read.
  let personChecks = null, params = null, outOfRangeCount = 0;
  if (!isFamily) {
    const checks = await DB.all('healthChecks').catch(() => []);
    personChecks = checks.filter(c => c.personId === _healthPerson).sort((a, b) => b.date.localeCompare(a.date));
    params = (await getHealthParams()).slice().sort((a, b) => a.label.localeCompare(b.label));
    outOfRangeCount = params.reduce((count, p) => {
      for (const c of personChecks) {
        const n = c.parameters && normalizeParamEntry(c.parameters[p.id]);
        if (n && n.value != null && n.value !== '') {
          return count + (getParamStatus(n.value, effectiveRange(p, person.gender)) === 'good' ? 0 : 1);
        }
      }
      return count;
    }, 0);
  }

  // This row names whatever the tabs above selected - a person (their
  // avatar, name, age) or the family table (a family emoji + its label) -
  // and sticks to the top once scrolled there, same as the app header
  // above it, so it's still clear who/what a card further down belongs to.
  const selected = el('div', { class: 'hc-selected' }, [
    // Segment 1: avatar + name/age, as before.
    el('div', { class: 'hc-selected-info' }, [
      el('div', { class: 'hc-avatar' }, [
        isFamily
          ? el('img', { src: 'icons/emoji/family.png', alt: '', style: 'width: 1.3em; height: 1.3em; display: inline-block; vertical-align: middle;' })
          : personAvatarImg(age, person.gender, '1.3em'),
      ]),
      el('div', {}, [
        el('div', { class: 'hc-selected-name', text: isFamily ? 'Family Health of ' + people.length + ' members' : person.name }),
        (!isFamily && age != null) ? el('div', { class: 'hc-selected-age', text: age + 'y' }) : null,
      ].filter(Boolean)),
    ]),
    // Segment 2: BMI, stacked - score on top (bigger), category below,
    // then how many kg to the healthy band. Only for a real person with
    // both height AND weight on record - see calcBmi.
    (!isFamily && calcBmi(person.heightCm, person.weightKg)) ? (() => {
      const b = calcBmi(person.heightCm, person.weightKg);
      return el('div', { class: 'hc-bmi hc-bmi-' + b.cls }, [
        el('span', { class: 'hc-bmi-val', text: 'BMI ' + b.bmi }),
        el('span', { class: 'hc-bmi-cat', text: b.category }),
        b.deltaKg != null ? el('span', { class: 'hc-bmi-delta', text: (b.deltaDir === 'gain' ? '+' : '−') + b.deltaKg + 'kg to healthy' }) : null,
      ].filter(Boolean));
    })() : null,
    // Segment 3: Out of Range filter (person page only) plus Share, which
    // renders everything from this row down to the last entry into a
    // shareable PNG - the family table on the Family page, this person's
    // own readings on their page. Share sits below Out of Range and reads
    // smaller on a person's page - Out of Range is the primary action there.
    el('div', { class: 'hc-selected-actions' }, [
      // With nothing out of range there's nothing to filter to, so this stops
      // being a control and becomes a plain status label - a button that only
      // ever shows an empty list is a button that shouldn't be pressable.
      isFamily ? null : (outOfRangeCount === 0
        ? el('div', { class: 'hc-filter-btn hc-filter-btn-clear', text: 'All is Well' })
        : el('button', {
            class: 'hc-filter-btn' + (_hcFilterOutOfRange ? ' active' : ''),
            onclick: () => { _hcFilterOutOfRange = !_hcFilterOutOfRange; renderHealthCheck(); },
          }, ['Out of Range', el('span', { class: 'hc-filter-count', text: String(outOfRangeCount) })])),
      el('button', {
        class: 'hc-share-btn' + (isFamily ? '' : ' hc-share-btn-sm'),
        title: isFamily ? 'Share family table as an image' : "Share " + person.name + "'s records as an image",
        onclick: () => isFamily ? shareFamilyTableImage() : sharePersonImage(person),
      }, [el('img', { src: 'icons/health-share.png', alt: '' })]),
    ].filter(Boolean)),
  ].filter(Boolean));
  host.appendChild(selected);
  // CSS doesn't auto-stack sticky siblings - two elements both pinned at
  // top:0 just overlap, with the app header (the higher z-index) covering
  // this one entirely. Push it down by the header's actual rendered height
  // so it sticks directly beneath the header instead of behind it.
  const appHeader = document.querySelector('.app-header');
  if (appHeader) selected.style.top = appHeader.offsetHeight + 'px';

  if (isFamily) {
    fab.classList.add('hidden');
    const params = (await getHealthParams()).slice().sort((a, b) => a.label.localeCompare(b.label));
    host.appendChild(await renderFamilyTable(people, params));
    return;
  }

  fab.classList.remove('hidden');
  fab.onclick = () => openHealthCheckForm(person);

  if (!personChecks.length) {
    host.appendChild(el('div', { class: 'hc-empty', text: 'No records yet. Tap the + button to add one.' }));
    return;
  }

  const sections = el('div', {});
  let shown = 0;
  params.forEach(p => {
    const entries = personChecks
      .map(c => { const n = c.parameters && normalizeParamEntry(c.parameters[p.id]); return n && n.value != null && n.value !== '' ? { date: c.date, checkType: c.checkType, value: n.value, lab: c.lab, medicineTaken: n.medicineTaken } : null; })
      .filter(Boolean);
    if (!entries.length) return;
    if (_hcFilterOutOfRange && getParamStatus(entries[0].value, effectiveRange(p, person.gender)) === 'good') return;
    shown++;
    sections.appendChild(renderParamSection(p, entries, person.gender));
  });
  if (_hcFilterOutOfRange && !shown) {
    sections.appendChild(el('div', { class: 'hc-empty', text: 'Nothing out of range for the latest check of each parameter.' }));
  }
  host.appendChild(sections);
}

// scrollIntoView's block:'start' aligns the card's top edge with the very
// top of the scroll area - exactly where the sticky app header and the
// sticky .hc-selected name/BMI row sit (see renderHealthCheck), so both the
// card AND the row naming who it belongs to end up hidden behind them.
// This scrolls to the same card but shifted down past both sticky layers.
function scrollCardBelowStickyHeaders(card) {
  const appHeader = document.querySelector('.app-header');
  const selectedRow = document.querySelector('.hc-selected');
  const stickyH = (appHeader ? appHeader.offsetHeight : 0) + (selectedRow ? selectedRow.offsetHeight : 0);
  const y = card.getBoundingClientRect().top + window.scrollY - stickyH - 8;
  window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}

// One row per parameter, one column per family member, each cell a traffic-
// light DOT for their LATEST reading for that parameter (not their whole
// history, and not the value itself) - a quick side-by-side glance instead
// of paging through each person one at a time. Blank/hollow when a person
// has never recorded that parameter. Tapping a dot jumps to that person's
// own page with the parameter's card expanded (see openFamilyCell below).
async function renderFamilyTable(people, params) {
  const checks = await DB.all('healthChecks').catch(() => []);
  const byPerson = new Map(people.map(p => [p.id, checks.filter(c => c.personId === p.id).sort((a, b) => b.date.localeCompare(a.date))]));

  const headerRow = el('tr', {}, [
    el('th', { text: 'Parameter' }),
    ...people.map(p => el('th', {}, [personAvatarImg(calcAge(p.dob), p.gender, '1em'), ' ' + p.name])),
  ]);

  const openFamilyCell = (person, param, hasEntry) => {
    _hcView = null;
    _healthPerson = person.id;
    _expandedParamId = hasEntry ? param.id : null;
    renderHealthCheck().then(() => {
      const card = Array.from(document.querySelectorAll('.hc-card')).find(c => c.dataset.paramId === String(param.id));
      if (card) scrollCardBelowStickyHeaders(card);
    });
  };

  // BMI isn't one of the user's own configurable parameters (see
  // getHealthParams) - it's computed from height/weight, same as the badge
  // on a person's own page (calcBmi) - so its row is built separately and
  // pinned first, ahead of whatever parameters people actually have
  // readings for. No parameter card exists for it to expand into, so a tap
  // just opens that person's page rather than scrolling to anything.
  const bmiRow = el('tr', {}, [
    el('td', { class: 'hc-family-param', text: 'BMI' }),
    ...people.map(person => {
      const goToPerson = () => { _hcView = null; _healthPerson = person.id; renderHealthCheck(); };
      const bmi = calcBmi(person.heightCm, person.weightKg);
      if (!bmi) {
        // Nothing to open - no height/weight on record yet, so this cell
        // just isn't clickable.
        return el('td', {}, [
          el('span', { class: 'hc-dot hc-dot-blank', title: person.name + ' - BMI: no data' }),
        ]);
      }
      return el('td', { class: 'hc-dot-cell', onclick: goToPerson }, [
        el('span', { class: 'hc-dot', style: 'background: ' + getStatusColor(bmi.cls) + ';', title: person.name + ' - BMI ' + bmi.bmi + ' ' + bmi.category }),
      ]);
    }),
  ]);

  const bodyRows = params.map(p => {
    const cells = people.map(person => {
      const personChecks = byPerson.get(person.id) || [];
      let latest = null;
      for (const c of personChecks) {
        const n = c.parameters && normalizeParamEntry(c.parameters[p.id]);
        if (n && n.value != null && n.value !== '') { latest = n; break; }
      }
      if (!latest) {
        // Nothing recorded for this person/parameter yet - no reading to
        // jump to, so this cell just isn't clickable.
        return el('td', {}, [
          el('span', { class: 'hc-dot hc-dot-blank', title: person.name + ' - ' + p.label + ': no data' }),
        ]);
      }
      const status = getParamStatus(latest.value, effectiveRange(p, person.gender));
      const title = person.name + ' - ' + p.label + ': ' + latest.value + (p.unit ? ' ' + p.unit : '') + (latest.medicineTaken ? ' (medicine taken)' : '');
      return el('td', { class: 'hc-dot-cell', onclick: () => openFamilyCell(person, p, true) }, [
        el('span', { class: 'hc-dot-wrap', title }, [
          el('span', { class: 'hc-dot', style: 'background: ' + getStatusColor(status) + ';' }),
          // Small shield over the dot when medicine was on board for this
          // reading - the same fact the person page shows as a 💊 pill, but
          // a dot this size has no room for text, so a shield reads as
          // "covered/adjusted" at a glance instead.
          latest.medicineTaken ? el('span', { class: 'hc-dot-med', text: '🛡️' }) : null,
        ].filter(Boolean)),
      ]);
    });
    return el('tr', {}, [
      el('td', { class: 'hc-family-param', text: p.label }),
      ...cells,
    ]);
  });

  return el('div', { class: 'hc-family-wrap' }, [
    el('table', { class: 'hc-family-table' }, [
      el('thead', {}, [headerRow]),
      el('tbody', {}, [bmiRow, ...bodyRows]),
    ]),
  ]);
}

// Truncates text to fit maxWidth px in ctx's current font, adding an
// ellipsis - canvas has no CSS text-overflow, so this is that by hand.
function _canvasTruncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

// Canvas has no built-in rounded-rect path in every supported browser -
// traces one by hand for the lab-name badge in sharePersonImage.
function _canvasRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Compact "Recent"/"Nm ago"/"Ny ago" for the blue badge in sharePersonImage -
// shorter than timeAgoLabel's "N months ago" since it has to fit inside a
// pill alongside the lab badge and medicine emoji, not stand alone.
// Anything inside the last month reads as "Recent" rather than counting the
// days: whoever the image is shared with wants to know whether a reading is
// current, and 6 days versus 20 doesn't change that answer.
function _canvasTimeAgo(dateStr) {
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return '';
  const now = new Date();
  const days = Math.floor((now - then) / 86400000);
  if (days < 31) return 'Recent';
  let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  if (now.getDate() < then.getDate()) months--;
  if (months < 12) return months + 'm ago';
  return Math.floor(months / 12) + 'y ago';
}

// Every shared image gets the same app icon top-right and the same footer
// underneath. Once an image leaves the app it carries no other context, so
// whoever receives it can see where the numbers came from - and that it's
// somebody's own running record, not a lab report or a clinical document.
const SHARE_FOOTER_H = 42;
// Kept short enough to fit the narrowest image this draws - a one-person
// family table is only ~250px wide, and a truncated disclaimer says less
// than a brief one.
const SHARE_DISCLAIMER = 'Self-recorded in MyNotes - not a medical report.';

let _appIconPromise = null;
function _loadAppIcon() {
  if (!_appIconPromise) {
    // Resolves to null rather than rejecting: a missing icon should cost the
    // image its logo, not the whole share.
    _appIconPromise = new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = 'icons/icon-192.png';
    });
  }
  return _appIconPromise;
}

// Rounded like an app icon rather than a bare square, matching how the same
// artwork reads on a home screen.
function _drawAppIcon(ctx, icon, x, y, size) {
  if (!icon) return;
  ctx.save();
  _canvasRoundRect(ctx, x, y, size, size, size * 0.22);
  ctx.clip();
  ctx.drawImage(icon, x, y, size, size);
  ctx.restore();
}

function _drawShareChrome(ctx, icon, width, height, pad, FONT) {
  _drawAppIcon(ctx, icon, width - pad - 38, pad, 38);

  const y = height - SHARE_FOOTER_H;
  ctx.strokeStyle = '#e3e7ee';
  ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  _drawAppIcon(ctx, icon, pad, y + 9, 13);
  ctx.font = '700 10px ' + FONT;
  ctx.fillStyle = '#0e1726';
  ctx.fillText('MyNotes', pad + (icon ? 18 : 0), y + 16);
  ctx.font = '400 7px ' + FONT;
  ctx.fillStyle = '#8a94a6';
  ctx.fillText(_canvasTruncate(ctx, SHARE_DISCLAIMER, width - pad * 2), pad, y + 32);
}

// Redraws the same Family table (parameter rows x person columns of status
// dots - see renderFamilyTable above, which this deliberately mirrors) onto
// a flat PNG, then hands it to the Web Share API so it can go to WhatsApp,
// email, etc. straight from the button - a live DOM table can't be shared
// as-is outside the app. Falls back to a plain download where file sharing
// isn't supported (e.g. a desktop browser). Always drawn on a white
// background regardless of the app's own theme, since the point is for
// someone else to read it standalone.
async function shareFamilyTableImage() {
  try {
    const people = await DB.all('healthPeople');
    if (!people.length) { toast('No family members to share'); return; }
    const params = (await getHealthParams()).slice().sort((a, b) => a.label.localeCompare(b.label));
    const checks = await DB.all('healthChecks').catch(() => []);
    const byPerson = new Map(people.map(p => [p.id, checks.filter(c => c.personId === p.id).sort((a, b) => b.date.localeCompare(a.date))]));

    const latestFor = (person, param) => {
      const personChecks = byPerson.get(person.id) || [];
      for (const c of personChecks) {
        const n = c.parameters && normalizeParamEntry(c.parameters[param.id]);
        if (n && n.value != null && n.value !== '') return n;
      }
      return null;
    };
    // Only rows someone actually has a reading for - an all-blank row would
    // just be dead space in a static image nobody can tap through. BMI is
    // the one exception - like the on-screen table (renderFamilyTable), it's
    // always pinned first regardless, since it's computed from height/weight
    // rather than a logged reading.
    const rows = params.filter(p => people.some(person => latestFor(person, p)));
    const hasBmi = people.some(p => calcBmi(p.heightCm, p.weightKg));
    if (!rows.length && !hasBmi) { toast('No records yet to share'); return; }
    rows.unshift({ __bmi: true, label: 'BMI' });

    const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#8a94a6';
    const statusColor = (status) => { const c = getStatusColor(status); return c.startsWith('var(') ? mutedColor : c; };

    const appIcon = await _loadAppIcon();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const paramColW = 130, colW = 88, rowH = 34, headH = 40, pad = 16, titleH = 44;
    const width = pad * 2 + paramColW + colW * people.length;
    const height = titleH + headH + rowH * rows.length + pad + SHARE_FOOTER_H;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const FONT = '-apple-system, Segoe UI, Roboto, Arial, sans-serif';

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0e1726';
    ctx.font = '700 17px ' + FONT;
    ctx.fillText('Family Health', pad, pad + 14);
    ctx.fillStyle = '#8a94a6';
    ctx.font = '400 11px ' + FONT;
    ctx.fillText(new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }), pad, pad + 32);

    const top = pad + titleH;
    ctx.fillStyle = '#eef1f6';
    ctx.fillRect(pad, top, width - pad * 2, headH);
    ctx.font = '700 11px ' + FONT;
    ctx.fillStyle = '#0e1726';
    ctx.textAlign = 'left';
    ctx.fillText('Parameter', pad + 8, top + headH / 2);
    ctx.textAlign = 'center';
    people.forEach((p, i) => {
      const cx = pad + paramColW + colW * i + colW / 2;
      ctx.fillText(_canvasTruncate(ctx, p.name, colW - 10), cx, top + headH / 2);
    });

    rows.forEach((param, ri) => {
      const y = top + headH + rowH * ri;
      ctx.fillStyle = ri % 2 === 0 ? '#ffffff' : '#f7f9fc';
      ctx.fillRect(pad, y, width - pad * 2, rowH);
      ctx.strokeStyle = '#e3e7ee';
      ctx.beginPath(); ctx.moveTo(pad, y + rowH); ctx.lineTo(width - pad, y + rowH); ctx.stroke();

      ctx.font = '600 11px ' + FONT;
      ctx.fillStyle = '#0e1726';
      ctx.textAlign = 'left';
      ctx.fillText(_canvasTruncate(ctx, param.label, paramColW - 16), pad + 8, y + rowH / 2);

      people.forEach((person, ci) => {
        const cx = pad + paramColW + colW * ci + colW / 2, cy = y + rowH / 2;

        if (param.__bmi) {
          const bmi = calcBmi(person.heightCm, person.weightKg);
          if (!bmi) {
            ctx.strokeStyle = '#c7cdd8';
            ctx.setLineDash([2, 2]);
            ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.stroke();
            ctx.setLineDash([]);
            return;
          }
          ctx.fillStyle = statusColor(bmi.cls);
          ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
          return;
        }

        const latest = latestFor(person, param);
        if (!latest) {
          ctx.strokeStyle = '#c7cdd8';
          ctx.setLineDash([2, 2]);
          ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          return;
        }
        const status = getParamStatus(latest.value, effectiveRange(param, person.gender));
        ctx.fillStyle = statusColor(status);
        ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
        // Small shield over the dot when medicine was on board for this
        // reading, mirroring the on-screen .hc-dot-med badge.
        if (latest.medicineTaken) {
          ctx.font = '8px ' + FONT;
          ctx.textAlign = 'center';
          ctx.fillText('🛡️', cx + 4.5, cy - 4.5);
        }
      });
    });

    ctx.strokeStyle = '#dfe3ea';
    ctx.strokeRect(pad, top, width - pad * 2, headH + rowH * rows.length);

    _drawShareChrome(ctx, appIcon, width, height, pad, FONT);
    await _shareCanvasImage(canvas, 'family-health.png', 'Family Health');
  } catch (e) {
    console.error('shareFamilyTableImage failed:', e);
    toast('Could not create image');
  }
}

// Shared tail end for every Health Check share button: blob the canvas, hand
// it to the Web Share API as a PNG file so it can go straight to WhatsApp,
// email, etc., and fall back to a plain download where file sharing isn't
// supported (e.g. a desktop browser).
function _shareCanvasImage(canvas, filename, shareTitle) {
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { toast('Could not create image'); resolve(); return; }
      const file = new File([blob], filename, { type: 'image/png' });
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: shareTitle });
          resolve();
          return;
        }
      } catch (e) {
        if (e.name === 'AbortError') { resolve(); return; } // user backed out of the share sheet
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Image saved');
      resolve();
    }, 'image/png');
  });
}

// Redraws one person's own page - the header row (avatar, name, age, BMI)
// down through their latest reading of every parameter they have one for,
// same content and order as the collapsed on-screen view - onto a flat PNG
// to share, same mechanism as shareFamilyTableImage above. Respects the
// current Out of Range filter, so what gets shared matches what's on screen.
async function sharePersonImage(person) {
  try {
    const checks = await DB.all('healthChecks').catch(() => []);
    const personChecks = checks.filter(c => c.personId === person.id).sort((a, b) => b.date.localeCompare(a.date));
    if (!personChecks.length) { toast('No records yet to share'); return; }
    const params = (await getHealthParams()).slice().sort((a, b) => a.label.localeCompare(b.label));

    const rows = [];
    params.forEach(p => {
      let latest = null;
      for (const c of personChecks) {
        const n = c.parameters && normalizeParamEntry(c.parameters[p.id]);
        if (n && n.value != null && n.value !== '') { latest = { date: c.date, checkType: c.checkType, value: n.value, lab: c.lab, medicineTaken: n.medicineTaken }; break; }
      }
      if (!latest) return;
      const status = getParamStatus(latest.value, effectiveRange(p, person.gender));
      if (_hcFilterOutOfRange && status === 'good') return;
      rows.push({ param: p, latest, status });
    });
    if (!rows.length) { toast('Nothing to share'); return; }

    const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#8a94a6';
    const statusColor = (status) => { const c = getStatusColor(status); return c.startsWith('var(') ? mutedColor : c; };

    const bmi = calcBmi(person.heightCm, person.weightKg);
    const appIcon = await _loadAppIcon();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = 360, pad = 16, headH = bmi && bmi.deltaKg != null ? 76 : 60, rowH = 64;
    const height = pad + headH + rowH * rows.length + SHARE_FOOTER_H;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const FONT = '-apple-system, Segoe UI, Roboto, Arial, sans-serif';

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // Header: initial-in-a-circle avatar (skips loading the actual emoji
    // asset - a solid, universally-readable stand-in for a static image).
    ctx.textBaseline = 'middle';
    const initial = (person.name || '?').trim().charAt(0).toUpperCase();
    ctx.fillStyle = '#eef1f6';
    ctx.beginPath(); ctx.arc(pad + 20, pad + 20, 20, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0e1726';
    ctx.font = '700 17px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillText(initial, pad + 20, pad + 21);

    ctx.textAlign = 'left';
    ctx.font = '700 17px ' + FONT;
    ctx.fillStyle = '#0e1726';
    // -46 keeps a long name clear of the app icon sitting in the top-right.
    ctx.fillText(_canvasTruncate(ctx, person.name, width - pad * 2 - 50 - 46), pad + 48, pad + 14);

    const age = calcAge(person.dob);
    let subLine = age != null ? age + 'y' : '';
    if (bmi) subLine += (subLine ? '  ·  ' : '') + 'BMI ' + bmi.bmi + ' ' + bmi.category;
    ctx.font = '400 11px ' + FONT;
    ctx.fillStyle = '#8a94a6';
    ctx.fillText(_canvasTruncate(ctx, subLine, width - pad - 48), pad + 48, pad + 32);

    // How many kg to the healthy band - its own line under the age/BMI line,
    // same information the on-screen BMI badge stacks (see the "hc-bmi"
    // segment in renderHealthCheck), only shown when calcBmi has it.
    if (bmi && bmi.deltaKg != null) {
      ctx.font = '600 11px ' + FONT;
      ctx.fillStyle = bmi.deltaDir === 'gain' ? '#fbbf24' : '#f87171';
      const deltaText = (bmi.deltaDir === 'gain' ? '+' : '−') + bmi.deltaKg + 'kg to healthy';
      ctx.fillText(_canvasTruncate(ctx, deltaText, width - pad - 48), pad + 48, pad + 48);
    }

    const top = pad + headH;
    ctx.strokeStyle = '#e3e7ee';
    ctx.beginPath(); ctx.moveTo(pad, top); ctx.lineTo(width - pad, top); ctx.stroke();

    ctx.font = '600 11px ' + FONT;
    rows.forEach((r, ri) => {
      const y = top + rowH * ri;
      if (ri % 2 === 1) { ctx.fillStyle = '#f7f9fc'; ctx.fillRect(pad, y, width - pad * 2, rowH); }

      // Test name, then its reference range in smaller muted text right
      // after it. On screen that range hides behind the (i) icon beside the
      // same name (renderParamSection) - a static image has nothing to tap,
      // so here it's spelled out.
      ctx.textAlign = 'left';
      const nameText = r.param.label + (r.param.unit ? ' (' + r.param.unit + ')' : '');
      const refText = paramRangeLabel(effectiveRange(r.param, person.gender));
      ctx.font = '400 8px ' + FONT;
      const refW = refText && refText !== '—' ? ctx.measureText(refText).width + 6 : 0;
      ctx.font = '700 12px ' + FONT;
      ctx.fillStyle = '#0e1726';
      const nameTrunc = _canvasTruncate(ctx, nameText, Math.max(40, width - pad * 2 - 90 - refW));
      ctx.fillText(nameTrunc, pad + 8, y + 18);
      if (refW) {
        const nameW = ctx.measureText(nameTrunc).width;
        ctx.font = '400 8px ' + FONT;
        ctx.fillStyle = '#8a94a6';
        ctx.fillText(refText, pad + 8 + nameW + 6, y + 19);
      }

      ctx.font = '400 10px ' + FONT;
      ctx.fillStyle = '#8a94a6';
      const dateStr = new Date(r.latest.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      ctx.fillText(_canvasTruncate(ctx, dateStr + (r.latest.checkType ? ' · ' + r.latest.checkType : ''), width - pad * 2 - 90), pad + 8, y + 34);

      // Lab (same muted pill the on-screen entry row uses, .hc-lab-tag) and,
      // right after it, the medicine-taken pill emoji (.hc-med-pill) - same
      // pairing as the on-screen sub-line in renderEntryRow.
      let subX = pad + 8;
      if (r.latest.lab) {
        ctx.font = '600 9px ' + FONT;
        const labText = _canvasTruncate(ctx, r.latest.lab, width - pad * 2 - 60);
        const tw = ctx.measureText(labText).width;
        const bx = subX, by = y + 42, bw = tw + 14, bh = 15;
        ctx.fillStyle = '#eef1f6';
        _canvasRoundRect(ctx, bx, by, bw, bh, 7.5);
        ctx.fill();
        ctx.fillStyle = '#6b7280';
        ctx.fillText(labText, bx + 7, by + bh / 2 + 0.5);
        subX = bx + bw + 6;
      }
      if (r.latest.medicineTaken) {
        ctx.font = '11px ' + FONT;
        ctx.fillText('💊', subX, y + 49.5);
        subX += 16;
      }

      // Blue "how long ago" badge - answers "is this old news or recent?"
      // at a glance, same spirit as the on-screen hc-trend-ago label.
      const ago = _canvasTimeAgo(r.latest.date);
      if (ago) {
        ctx.font = '600 7px ' + FONT;
        const tw2 = ctx.measureText(ago).width;
        // by2/bh2 keep this pill centred on the same line as the lab badge
        // beside it (y + 42, height 15) even though it's shorter.
        const bx2 = subX, by2 = y + 43.5, bw2 = tw2 + 11, bh2 = 12;
        ctx.fillStyle = 'rgba(37,99,235,0.12)';
        _canvasRoundRect(ctx, bx2, by2, bw2, bh2, 6);
        ctx.fill();
        ctx.fillStyle = '#2563eb';
        ctx.fillText(ago, bx2 + 5.5, by2 + bh2 / 2 + 0.5);
      }

      ctx.textAlign = 'right';
      ctx.font = '700 13px ' + FONT;
      ctx.fillStyle = '#0e1726';
      const valText = r.latest.value + (r.param.unit ? ' ' + r.param.unit : '');
      ctx.fillText(valText, width - pad - 16, y + rowH / 2);
      const dotX = width - pad - 26 - ctx.measureText(valText).width;
      ctx.fillStyle = statusColor(r.status);
      ctx.beginPath(); ctx.arc(dotX, y + rowH / 2, 5, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = '#e3e7ee';
      ctx.beginPath(); ctx.moveTo(pad, y + rowH); ctx.lineTo(width - pad, y + rowH); ctx.stroke();
    });

    _drawShareChrome(ctx, appIcon, width, height, pad, FONT);
    await _shareCanvasImage(canvas, (person.name || 'health').replace(/\s+/g, '-').toLowerCase() + '-health.png', person.name + "'s Health");
  } catch (e) {
    console.error('sharePersonImage failed:', e);
    toast('Could not create image');
  }
}

// entries is newest-first. Only the latest reading shows by default; tapping
// it expands the rest in place, as one continuous list with no separate
// "N more"/"Hide" row - only a small caption under the latest row's status
// icon while collapsed. Only one parameter is expanded at a time: expanding
// another closes this one, since they all share _expandedParamId.
function renderParamSection(param, entries, gender) {
  const [latest, ...older] = entries;
  const isExpanded = _expandedParamId === param.id;

  // Resolve once: a param without a gender override just gets its own
  // min/max back unchanged (see effectiveRange), so this is a no-op for
  // every existing parameter and only kicks in where Male/Female ranges
  // were actually set.
  const range = effectiveRange(param, gender);
  const resolved = range === param ? param : { ...param, min: range.min, max: range.max };

  // renderHealthCheck() rebuilds the whole view, which otherwise leaves the
  // page at the top - restore the scroll position once the rebuild (and its
  // awaited DB reads) finish, so expanding/collapsing an entry doesn't yank
  // the page away from where the tap happened.
  const toggle = () => {
    const y = window.scrollY;
    _expandedParamId = isExpanded ? null : param.id;
    renderHealthCheck().then(() => window.scrollTo(0, y));
  };

  // The reference range sits behind the (i) rather than on a permanent chip:
  // it's the same number on every card every time, so it's reference material
  // you check occasionally, not something worth a line of its own each time.
  // Tap or hover (title covers desktop, the toast covers phones).
  const intervalText = paramIntervalText(param, gender);
  const children = [
    el('div', { class: 'hc-card-head' }, [
      el('div', { class: 'hc-card-title' }, [
        param.label + (param.unit ? ' (' + param.unit + ')' : ''),
        el('span', {
          class: 'hc-param-info', text: 'i', title: intervalText,
          onclick: (e) => { e.stopPropagation(); toast(intervalText); },
        }),
      ]),
    ]),
    renderEntryRow(latest, resolved, {
      onClick: older.length ? toggle : null,
      moreCount: (!isExpanded && older.length) ? older.length : 0,
    }),
  ];

  if (isExpanded) older.forEach(e => children.push(renderEntryRow(e, resolved)));

  if (entries.length > 1) children.push(renderTrendGraph(resolved, entries));

  // data-param-id lets a tap on the Family table's indicator dot (see
  // renderFamilyTable) jump straight here and scroll it into view.
  return el('div', { class: 'hc-card', 'data-param-id': String(param.id) }, children);
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

// "3 months ago" / "2 years ago" for how stale the latest reading is -
// most useful exactly where the Out of Range filter puts a parameter in
// front of you: it answers "is this old news or did I just check?"
// without opening the entry itself.
function timeAgoLabel(dateStr) {
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return '';
  const now = new Date();
  let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  if (now.getDate() < then.getDate()) months--;
  if (months <= 0) return 'This month';
  if (months < 12) return months + (months === 1 ? ' month ago' : ' months ago');
  const years = Math.floor(months / 12);
  return years + (years === 1 ? ' year ago' : ' years ago');
}

// A small bar-per-reading trend strip, oldest to newest left-to-right so the
// bars read the same direction time does. Bar height reflects the value's
// position within this parameter's own min/max seen so far (not the healthy
// range) - the goal is "is it moving", not a second copy of the status color,
// which each bar also carries via its fill. A "N months/years ago" badge
// sits at the box's trailing edge, dated off the latest (first) entry.
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

  return el('div', { class: 'hc-trend' }, [
    el('div', { class: 'hc-trend-bars' }, bars),
    el('div', { class: 'hc-trend-ago', text: timeAgoLabel(entries[0].date) }),
  ]);
}

function getParamStatus(value, param) {
  const val = parseFloat(value);
  if (isNaN(val)) return 'unknown';

  if (param.intervalType === 'range') {
    if (param.min == null || param.max == null) return 'unknown';
    if (val >= param.min && val <= param.max) return 'good';
    if (val < param.min) return 'low';
    return 'high';
  } else if (param.intervalType === 'below') {
    if (param.max == null) return 'unknown';
    return val < param.max ? 'good' : 'high';
  } else if (param.intervalType === 'above') {
    if (param.min == null) return 'unknown';
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
  // Opened from the Health Check gear with no explicit tab, this should
  // land on the roster, not straight into the Add form - Add is still one
  // tap away on its own tab. Callers that specifically want the form (the
  // empty-state CTA, editing a row) pass 'add' themselves.
  const tab = activeTab || 'list';
  const isEdit = !!editing;

  const tabs = renderManagerTabs(tab, isEdit ? 'Edit' : 'Add', 'List', people.length, (next) => { closeModal(); openHealthPeopleManager(next); });

  const listBody = people.length
    ? el('div', {}, people.map(p => {
        const age = calcAge(p.dob);
        return el('div', { class: 'hc-list-row' }, [
          el('div', { style: 'width: 26px;' }, [personAvatarImg(age, p.gender, '1.3em')]),
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
  const heightInput = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'cm' });
  const weightInput = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'kg' });
  let gender = (isEdit && editing.gender) || null;

  const avatarPreview = el('div', { style: 'width: 48px; height: 48px; border-radius: 50%; background: var(--card); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; font-size: 1.6rem;' });
  const paintAvatar = () => { avatarPreview.innerHTML = ''; avatarPreview.appendChild(personAvatarImg(calcAge(dobInput.value), gender, '1.6em')); };

  const maleBtn = el('button', { type: 'button', text: '👨 Male', onclick: () => { gender = 'Male'; paintGender(); paintAvatar(); } });
  const femaleBtn = el('button', { type: 'button', text: '👩 Female', onclick: () => { gender = 'Female'; paintGender(); paintAvatar(); } });
  const paintGender = () => {
    maleBtn.className = 'btn' + (gender === 'Male' ? ' primary' : ' ghost');
    femaleBtn.className = 'btn' + (gender === 'Female' ? ' primary' : ' ghost');
  };
  paintGender();

  if (isEdit) {
    nameInput.value = editing.name || ''; dobInput.value = editing.dob || '';
    if (editing.heightCm != null) heightInput.value = editing.heightCm;
    if (editing.weightKg != null) weightInput.value = editing.weightKg;
  }
  paintAvatar();
  // Some mobile browsers only fire 'change' (not 'input') once a date is
  // picked via the native picker UI, so both are wired to be sure the
  // avatar preview actually updates.
  dobInput.addEventListener('input', paintAvatar);
  dobInput.addEventListener('change', paintAvatar);

  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('Enter a name'); return; }
    // Both optional, and BOTH-or-neither for BMI's sake: calcBmi already
    // requires both before it computes anything, so half a pair sitting on
    // record would just be dead weight nobody reads.
    const heightCm = heightInput.value === '' ? null : num(heightInput.value);
    const weightKg = weightInput.value === '' ? null : num(weightInput.value);
    const rec = { name, dob: dobInput.value || null, gender, heightCm, weightKg };
    if (isEdit) rec.id = editing.id;
    rec.id = await DB.put('healthPeople', rec);
    closeModal(); toast(isEdit ? 'Updated' : 'Added');
    // Back to wherever this form was reached from, not a fixed page: editing
    // (or adding a 2nd+ member) was reached from the List tab, so that's
    // "previous" and Save returns there. The one case with no List to go
    // back to is adding the very first family member ever (the empty-state
    // CTA, which never shows a List) - there, Save goes straight to that
    // person's own Records page, the natural next step for someone with
    // nobody logged yet.
    if (isEdit || people.length) openHealthPeopleManager('list');
    else openHealthRecordsManager(rec);
  };

  const formBody = el('div', {}, [
    el('div', { style: 'display: flex; justify-content: center; margin-bottom: 16px;' }, [avatarPreview]),
    field('Name', nameInput),
    field('Date of birth', dobInput),
    field('Gender', el('div', { style: 'display: flex; gap: 8px;' }, [maleBtn, femaleBtn])),
    // Height + weight, side by side like the health-check form's own value
    // fields - both optional, and only used together (see calcBmi) to show a
    // BMI indicator on the person's own header row.
    el('div', { class: 'field-row' }, [field('Height (cm)', heightInput), field('Weight (kg)', weightInput)]),
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
          p.genderSpecific ? el('div', { style: 'font-size: 0.76rem; color: var(--muted);' }, [
            '♂ ' + paramRangeLabel(effectiveRange(p, 'Male')) + '  ·  ♀ ' + paramRangeLabel(effectiveRange(p, 'Female')),
          ]) : null,
        ].filter(Boolean)),
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

  // Some parameters (Haemoglobin, HDL, ...) have different normal ranges
  // for men and women. Off by default - a param with nothing entered here
  // behaves exactly as before, using the one range above for everyone.
  const genderSpecificInput = el('input', { type: 'checkbox' });
  const genderSpecificField = el('label', { style: 'display: flex; align-items: center; gap: 10px; margin: 4px 2px 16px; cursor: pointer;' }, [
    genderSpecificInput, 'Different reference range for Male / Female',
  ]);
  const maleMinInput = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'Male min' });
  const maleMaxInput = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'Male max' });
  const femaleMinInput = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'Female min' });
  const femaleMaxInput = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'Female max' });
  const maleField = field('♂ Male min', maleMinInput);
  const maleMaxField = field('♂ Male max', maleMaxInput);
  const femaleField = field('♀ Female min', femaleMinInput);
  const femaleMaxField = field('♀ Female max', femaleMaxInput);
  const maleRow = el('div', { class: 'field-row' }, [maleField, maleMaxField]);
  const femaleRow = el('div', { class: 'field-row' }, [femaleField, femaleMaxField]);

  if (isEdit) {
    labelInput.value = editing.label || '';
    unitInput.value = editing.unit || '';
    typeInput.value = editing.intervalType || 'range';
    minInput.value = editing.min != null ? editing.min : '';
    maxInput.value = editing.max != null ? editing.max : '';
    genderSpecificInput.checked = !!editing.genderSpecific;
    maleMinInput.value = editing.maleMin != null ? editing.maleMin : '';
    maleMaxInput.value = editing.maleMax != null ? editing.maleMax : '';
    femaleMinInput.value = editing.femaleMin != null ? editing.femaleMin : '';
    femaleMaxInput.value = editing.femaleMax != null ? editing.femaleMax : '';
  }

  // Gender-specific replaces the common range rather than supplementing it -
  // once it's on, the common Min/Max are hidden entirely and only the
  // Male/Female fields (for the chosen type) are asked for.
  const syncFields = () => {
    const showGender = genderSpecificInput.checked;
    minField.style.display = (showGender || typeInput.value === 'below') ? 'none' : '';
    maxField.style.display = (showGender || typeInput.value === 'above') ? 'none' : '';
    maleField.style.display = femaleField.style.display = typeInput.value === 'below' ? 'none' : '';
    maleMaxField.style.display = femaleMaxField.style.display = typeInput.value === 'above' ? 'none' : '';
    maleRow.style.display = femaleRow.style.display = showGender ? '' : 'none';
  };
  typeInput.addEventListener('change', syncFields);
  genderSpecificInput.addEventListener('change', syncFields);
  syncFields();

  const save = async () => {
    const label = labelInput.value.trim();
    if (!label) { toast('Enter a parameter name'); return; }
    const intervalType = typeInput.value;
    const genderSpecific = genderSpecificInput.checked;

    let min = null, max = null;
    if (!genderSpecific) {
      min = num(minInput.value);
      max = num(maxInput.value);
      if (intervalType === 'range' && (min == null || max == null)) { toast('Enter both min and max'); return; }
      if (intervalType === 'below' && max == null) { toast('Enter the max limit'); return; }
      if (intervalType === 'above' && min == null) { toast('Enter the min limit'); return; }
    }

    const rec = { label, unit: unitInput.value.trim(), intervalType, min, max, genderSpecific: false, maleMin: null, maleMax: null, femaleMin: null, femaleMax: null };
    if (genderSpecific) {
      const maleMin = num(maleMinInput.value), maleMax = num(maleMaxInput.value);
      const femaleMin = num(femaleMinInput.value), femaleMax = num(femaleMaxInput.value);
      if (intervalType === 'range' && (maleMin == null || maleMax == null || femaleMin == null || femaleMax == null)) { toast('Enter both Male and Female min/max'); return; }
      if (intervalType === 'below' && (maleMax == null || femaleMax == null)) { toast('Enter the Male and Female max limits'); return; }
      if (intervalType === 'above' && (maleMin == null || femaleMin == null)) { toast('Enter the Male and Female min limits'); return; }
      rec.genderSpecific = true;
      rec.maleMin = maleMin;
      rec.maleMax = maleMax;
      rec.femaleMin = femaleMin;
      rec.femaleMax = femaleMax;
    }
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
    genderSpecificField,
    maleRow,
    femaleRow,
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
    const input = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: paramRangeLabel(effectiveRange(p, person.gender)) + (p.unit ? ' ' + p.unit : '') });
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
    closeModal(); toast(isEdit ? 'Health check updated' : 'Health check added');
    // Editing only ever happens from within that person's Records page (the
    // ✏️ in openHealthRecordsManager's list), so Update returns there rather
    // than falling through to the main Health Check page - which could be
    // showing a different person or the Family table entirely, whatever it
    // was on before Records was opened. Adding (the FAB, from the main page
    // itself) stays on that same main page, unchanged.
    if (isEdit) openHealthRecordsManager(person);
    else renderHealthCheck();
  };

  const del = async () => {
    if (!window.confirm('Delete this health check record?')) return;
    await DB.del('healthChecks', existing.id);
    closeModal(); toast('Removed'); openHealthRecordsManager(person);
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
