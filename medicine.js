// Medicine Cabinet (a part of Health Check): the household's medicines with their expiry, type, purpose and how to
// use them. Pure logic - no DOM, no storage - so the status rules are decided here, in one place, and tested.
// Ported from the sibling mynote-app repo (medicine.js).
//
// Record shape (store 'medicines', added in DB v20):
//   { id, name, type, purpose, usage,            // usage = how to take it, as written by the person
//     personId,                                  // a Health Check person, or null for the whole household
//     expiry: 'YYYY-MM',                         // month and year, as printed on the pack
//     boughtOn: 'YYYY-MM-DD' | '',
//     status: 'active' | 'used' | 'disposed',    // used up, or thrown away once expired
//     closedOn: 'YYYY-MM-DD' | null,             // when it was marked used up or disposed
//     createdAt, updatedAt }

export const MED_TYPES = ['Tablet', 'Capsule', 'Syrup', 'Drops', 'Cream / ointment', 'Inhaler', 'Injection', 'Powder / sachet', 'Spray', 'Other'];
export const MED_PURPOSES = ['Fever', 'Pain', 'Cold / cough', 'Stomach', 'Allergy', 'First aid', 'Skin', 'BP / sugar', 'Vitamins', 'Other'];

// How far ahead an expiry counts as "coming up": time enough to buy a fresh pack before this one runs out of date.
export const MED_SOON_DAYS = 30;

// The safe way to get rid of one, said in one place so the card and the confirm agree.
export const DISPOSE_TIP = 'Don’t flush it or pour it down the drain. A pharmacy take-back is best; otherwise take it out of the strip or bottle, '
  + 'mix it with used tea leaves or soil in a sealed bag, and put it in the bin.';

const DAY = 86400000;
const isYm = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));

// A pack printed "EXP 03/2027" is good through the LAST day of March 2027.
export function expiryEnd(ym) {
  if (!isYm(ym)) return null;
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return y + '-' + String(m).padStart(2, '0') + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0');
}

// Days from today (a 'YYYY-MM-DD' local date) to the end of the expiry month: 0 on its last day, negative once expired.
export function daysToExpiry(ym, today) {
  const end = expiryEnd(ym);
  if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return null;
  return Math.round((Date.parse(end) - Date.parse(today)) / DAY);
}

// Where one medicine stands today.
//   used / disposed   closed: kept only as history
//   expired           past its expiry month - dispose of it (and buy again if it is still needed)
//   soon              expires within MED_SOON_DAYS - buy a fresh one before then
//   ok                fine
//   unknown           no expiry recorded
export function medStatus(m, today, soonDays = MED_SOON_DAYS) {
  const st = m && m.status;
  if (st === 'used' || st === 'disposed') return { state: st, days: null };
  const days = daysToExpiry(m && m.expiry, today);
  if (days == null) return { state: 'unknown', days: null };
  if (days < 0) return { state: 'expired', days };
  if (days <= soonDays) return { state: 'soon', days };
  return { state: 'ok', days };
}

// The "Coming up" list: everything still in the cabinet that has expired or is about to - expired first, then the
// soonest. Closed (used up / disposed) medicines never appear.
export function comingUp(list, today, soonDays = MED_SOON_DAYS) {
  return (list || [])
    .map((m) => ({ m, s: medStatus(m, today, soonDays) }))
    .filter((x) => x.s.state === 'expired' || x.s.state === 'soon')
    .sort((a, b) => a.s.days - b.s.days || String(a.m.name || '').localeCompare(String(b.m.name || '')))
    .map((x) => Object.assign({}, x.m, { _status: x.s }));
}

// The cabinet itself, in the order worth reading it: the soonest expiry first, anything without an expiry last.
export function sortByExpiry(list) {
  return (list || []).slice().sort((a, b) => {
    const ea = isYm(a.expiry) ? a.expiry : '9999-99', eb = isYm(b.expiry) ? b.expiry : '9999-99';
    return ea.localeCompare(eb) || String(a.name || '').localeCompare(String(b.name || ''));
  });
}

// A fresh copy for "buy again": the same medicine with the purchase and expiry left for the new pack.
export function restockCopy(m) {
  return {
    name: m.name || '', type: m.type || '', purpose: m.purpose || '', usage: m.usage || '',
    personId: m.personId != null ? m.personId : null, expiry: '', boughtOn: '', status: 'active', closedOn: null,
  };
}

// "Mar 2027" for 'YYYY-MM'.
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function expiryLabel(ym) {
  return isYm(ym) ? MONS[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4) : 'No expiry noted';
}

// The short word a card shows for its status.
export function statusText(s) {
  if (!s) return '';
  if (s.state === 'expired') return s.days === -1 ? 'Expired yesterday' : 'Expired';
  if (s.state === 'soon') return s.days === 0 ? 'Expires today' : s.days === 1 ? 'Expires tomorrow' : 'Expires in ' + s.days + ' days';
  if (s.state === 'used') return 'Used up';
  if (s.state === 'disposed') return 'Disposed';
  if (s.state === 'unknown') return 'No expiry';
  return 'In date';
}
