# Health Check

A family medical-records surface — one of the six cards on Home (`icons/health-card.png`, subtext "Medical records · Family history"). Lazy-loaded (`import('./health.js')` from `setAppMode('health')`) so the rest of the app never pays for it. Modelled on no particular sheet — this one was designed from scratch for tracking lab-test parameters (Fasting Sugar, HbA1c, BP, ...) per family member over time.

## Files

- **`health.js`** (~856 lines) — everything: rendering, forms, avatar logic, status/trend math. No separate pure-logic module like `bonds.js`/`fd.js` — the calculations here (`getParamStatus`, `calcAge`, `effectiveRange`) are small enough to live alongside the DOM code.
- **`app.js`** — `setAppMode('health')` shows/hides `#healthView` + `#healthAddBtn`; the Home card; nothing else — `health.js` owns its own FAB wiring (`fab.onclick = () => openHealthCheckForm(person)`) each render.
- **`db.js`** — three stores: `healthPeople` (v18), `healthChecks` (v18), `healthParams` (v19).

## ⚠️ Not in backup — `exportAll()`/`importAll()` gap

**`healthPeople`, `healthChecks` and `healthParams` are not included in `DB.exportAll()`/`importAll()`** (`db.js`). Every other store added since — `spends`/`personalSpends`/`vault` (v15–17) — was correctly added to both; the three Health Check stores (v18–19) were not. `gotchas.md` already warns about exactly this trap ("a new store must also be added to `exportAll()` AND `importAll()`... otherwise it would be silently missing from backups") — it happened anyway here. **Practical effect: a folder-based Backup & Restore today silently drops all Health Check data.** Flagged to the user 2026-09-15; fix is a 6-line addition to `db.js` mirroring the `vault` pattern, not yet applied.

## Data model

### `healthPeople` (v18) — one row per family member

```js
{ id, name, dob: 'YYYY-MM-DD' | null, gender: 'Male' | 'Female' | null }
```

No `age` field — **age is derived from `dob`** via `calcAge()` on every render, "so a person's avatar and any age display stay correct on their own as years pass instead of quietly going stale until someone reopens their record to bump a number." A person with no DOB gets `age = null`, which the avatar picker (below) treats as adult.

### `healthChecks` (v18, indexes `personId` + `ym`) — one row per visit

```js
{
  id, personId, date: 'YYYY-MM-DD', ym: 'YYYY-MM',   // ym derived from date at save time
  checkType: 'Annual Check-up' | 'Periodic Check-up' | '',
  lab: 'SRL Diagnostics',                              // free text
  notes: '',
  parameters: {
    [paramId]: { value: 98, medicineTaken: false },    // current shape
  },
}
```

**Schema migration, handled without a version bump:** `parameters[id]` used to be stored as a bare number; a later change added `medicineTaken` (medicine is asked **per parameter**, not once for the whole visit, since "whether medicine was on board varies test to test"), which needed the value wrapped in an object. `normalizeParamEntry(raw)` reads **both shapes** — `typeof raw === 'object'` returns it as-is (defaulting `medicineTaken` to `false`), otherwise wraps the bare number. Every reader (listing, trend graph, Family Health table, edit form) goes through this function, so pre-migration records still display and edit correctly. This was a real data-loss bug caught during development — skipping the object shape silently blanked out every existing reading — which is also why the standing instruction from the user is to always confirm an old schema still reads correctly before shipping a shape change.

### `healthParams` (v19) — user-editable parameter definitions

```js
{
  id, label: 'Fasting Sugar', unit: 'mg/dL',
  intervalType: 'range' | 'below' | 'above',
  min, max,                                    // the common range (used when genderSpecific is false)
  genderSpecific: false,
  maleMin, maleMax, femaleMin, femaleMax,       // used when genderSpecific is true
}
```

Seeded once (`getHealthParams()`, guarded by "no params yet" rather than a meta flag) with 9 defaults: Fasting Sugar, HbA1c, Total Cholesterol, LDL, HDL, Triglycerides, Haemoglobin, BP Systolic, BP Diastolic. After that the user owns the list entirely via the gear icon → Parameters.

**Gender-specific ranges** are additive, not a replacement schema: `effectiveRange(param, gender)` returns the param unchanged when `genderSpecific` is false (a no-op for every parameter that predates this feature), and only substitutes `{maleMin,maleMax}`/`{femaleMin,femaleMax}` when the flag is on **and** that gender's fields are actually set. The Parameters form enforces this at save time — with `genderSpecific` on, the common Min/Max fields are hidden and only Male/Female fields are asked for; turning it off falls straight back to one range for everyone.

## Avatar system

Ten fixed SVG assets (`icons/emoji/*.svg`, Twemoji-derived, medium/Indian skin tone) — **five age brackets × Male/Female**, no neutral variant:

| Bracket | Age range | Male asset | Female asset |
|---|---|---|---|
| Baby | 0–4 | `baby-boy.svg` | `baby-girl.svg` |
| Child | 5–12 | `child-boy.svg` | `child-girl.svg` |
| Teen | 13–24 | `teen-boy.svg` | `teen-girl.svg` |
| Adult | 25–50 | `adult-man.svg` | `adult-woman.svg` |
| Old | 51+ | `old-man.svg` | `old-woman.svg` |

`personAvatarKey(age, gender)` picks the bracket from age (`age == null` → `'adult'`), then `gender === 'Female' ? AVATAR_FEMALE[bracket] : AVATAR_MALE[bracket]` — **an unset or male gender both fall back to the male half** of whichever bracket the age lands in, matching the app's pre-avatar-system default. Rendered as an `<img src="icons/emoji/<key>.svg">`, not a Unicode emoji character — "system emoji fonts render the same character differently on every device," so a bundled SVG set looks identical everywhere instead. The Family Health tab gets its own icon, `icons/emoji/family.png`, separate from the per-person set.

Teen borrows Twemoji's graduation-cap "student" figure — there's no dedicated teen glyph in Unicode, and the school/college-age imagery fits the 13–24 bracket.

## Status colours & reference ranges

`getParamStatus(value, param)` returns `'good' | 'high' | 'low' | 'unknown'` from the param's `intervalType`:
- `range` — good between `min`/`max` inclusive, `low` under, `high` over.
- `below` — good under `max` (strict), else `high`.
- `above` — good over `min` (strict), else `low`.
- `unknown` if the value doesn't parse or the needed bound is missing.

Colours: good `#34d399` (green), high `#f87171` (red), low `#fbbf24` (amber), unknown `var(--muted)`. Icons: `✓ / ↑ / ↓ / ?`. Every status-colored badge in the UI (entry rows, Family Health cells, trend-graph bars) goes through the same three helpers (`getStatusIcon/Color/Bg`), so a colour change is one edit.

## Per-person view (`renderHealthCheck`)

- **Person tabs** (`.hc-tabs`) across the top, plus a leading **"Family Health"** tab — switching view rebuilds the whole tab strip from scratch, which would otherwise reset `scrollLeft` to 0 on every tap; `selectTab()` captures `personTabs.scrollLeft` before the state change and restores it after the re-render resolves, so picking a person scrolled out of view doesn't snap the strip back to the start.
- **Selected-person header** (`.hc-selected`) — avatar + name + age (or the family icon + member count), plus an **Out of Range** toggle button (per-person view only). This header is `position:sticky`, but sticking two elements both at `top:0` doesn't auto-stack in CSS — the higher-z-index app header just covers this one. Fixed by reading `appHeader.offsetHeight` and setting `selected.style.top` to that value in JS, so it sticks directly beneath the real header instead of behind it.
- **Out of Range filter** (`_hcFilterOutOfRange`) — hides any parameter whose **latest** reading is inside its healthy range; a parameter that was once abnormal but has since normalized drops out too, since only the latest value is checked.
- **Per-parameter card** (`renderParamSection`) — shows the **latest** reading only, collapsed; tapping it expands the rest of that parameter's history in place as one continuous list (no separate "N more" row, just a small caption under the latest row while collapsed). Only one parameter is expanded at a time (`_expandedParamId` is a single value, not a set) — expanding another closes whichever was open. Expanding/collapsing re-renders the whole view (same DB reads as any other render), so the page would otherwise jump to the top; the toggle captures `window.scrollY` first and restores it once the re-render's promise resolves.
- **Entry row** (`renderEntryRow`) — a calendar chip (below) + check-type badge + lab tag + a 💊 pill when medicine was taken for that specific reading + the value + a status badge. A row with more readings behind it is clickable to expand.
- **Trend graph** (`renderTrendGraph`) — a bar-per-reading strip, oldest→newest left-to-right. Bar height reflects the value's position within *that parameter's own min/max seen so far* (not the healthy range) — the graph is answering "is it moving," which the status colour (also on each bar) already covers on its own axis. A **"N months/years ago" badge** sits at the trailing edge (`timeAgoLabel`, dated off the latest entry) — most useful exactly where the Out of Range filter puts a parameter in front of you, answering "is this old news or did I just check?" without opening the row.
- **Calendar chip** (`calChip`) — a small two-line card (day+month on a coloured band, year underneath) used everywhere a date shows, instead of a raw ISO string. **Month colour is fixed per calendar month** (`MONTH_COLORS`, a 12-step HSL sweep from green at January to blue at December) shared by every entry in that month regardless of year or parameter — "a quick visual 'which month' cue when scanning a list of readings," with neighbouring months (Jun/Jul) reading as similar and Jan/Dec reading as clearly different.

## Family Health tab (`renderFamilyTable`)

One row per parameter, one column per family member, each cell the person's **latest** reading only (not their history) — "a quick side-by-side instead of paging through each person one at a time." A person who has never recorded that parameter gets a blank `—` cell. Each filled cell is a status-coloured badge, using the same `getParamStatus`/`effectiveRange(param, person.gender)` pipeline as the per-person view, so a value reads the same colour whichever tab it's viewed from.

## Add/edit forms

- **`openHealthCheckForm(person, existing)`** — date, check type, lab, then one field-row per parameter (value input + a 💊 "Medicine taken" checkbox beside it, sharing the app's existing `.field-row` 50/50 layout), then notes. Only parameters with a non-empty value are saved into `parameters{}` — leaving one blank doesn't write a `null`/`0` entry for it. Rejects a save with zero parameters filled in.
- **`openHealthPeopleManager`** / **`openHealthParamsManager`** — tabbed sheets (Add | List (N)), the same "Add first, List second" pattern used across the app's other manager modals. The People form shows a live avatar preview that updates as DOB/gender change (wired to both `input` and `change` on the date field, since "some mobile browsers only fire 'change' ... once a date is picked via the native picker UI"). Deleting a person cascades — removes every `healthChecks` row with that `personId` — with a confirm that says so up front.
- **`openHealthRecordsManager(person)`** — reached from a small 📋 icon on a person's row in the People list; every check for that person, newest first, each independently editable/deletable (not only ever addable through the main FAB).

## Not built

- **Backup coverage** — see the warning above; this is the most consequential gap.
- **No seed data** — unlike Bonds/MF/FD, there's no source sheet this was modelled on, so every family member, parameter and reading is entered by hand from the first use.
- **No unit conversion** — a parameter's unit is a fixed label (`mg/dL`, `%`, ...); there's no dual-unit support (e.g. mg/dL ↔ mmol/L) if a lab report ever uses a different convention.
- **No file/photo attachment** per check (e.g. a scanned lab report) — `notes` is free text only.
