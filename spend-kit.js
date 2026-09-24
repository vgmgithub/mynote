// The quick-entry pieces both spend forms share, household (Kitty) and Personal: recent categories first with the
// full list folded away, one-tap usual amounts, Today / Yesterday, a live "left after this" line and an inline
// "this is missing". The choices behind them are worked out in spend-quick.js.
// Ported from the sibling mynote-app repo (spend-kit.js, commit 585782c).
import { el } from './app.js';
import { dayShift } from './spend-quick.js';

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// "Recent" chips over the full category list. With enough history (`fold`) the full list folds behind "All
// categories", so the usual pick is one tap and the sheet is shorter. Without recents it is the full list, as before.
export function quickCategories({ recents, grid, current, onPick, fold }) {
  const btns = (recents || []).map((name) => el('button', {
    type: 'button', class: 'spend-cat-btn quick-cat' + (name === current ? ' active' : ''), text: name,
    onclick: () => onPick(name),
  }));
  const row = btns.length ? el('div', { class: 'quick-cats' }, [
    el('span', { class: 'quick-cats-label', text: 'Recent' }),
    el('div', { class: 'quick-cats-row' }, btns),
  ]) : null;
  const folded = !!(fold && row);
  const all = el('div', { class: 'quick-all' + (folded ? '' : ' open') }, [grid]);
  const toggle = row ? el('button', { type: 'button', class: 'quick-all-toggle', 'aria-expanded': folded ? 'false' : 'true' }, [
    el('span', { text: 'All categories' }),
    el('span', { class: 'quick-all-chev', 'aria-hidden': 'true', text: '▾' }),
  ]) : null;
  const setOpen = (open) => {
    all.classList.toggle('open', open);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  if (toggle) toggle.addEventListener('click', () => setOpen(!all.classList.contains('open')));
  return {
    node: el('div', { class: 'quick-cat-wrap' }, [row, toggle, all].filter(Boolean)),
    mark: (name) => btns.forEach((b) => b.classList.toggle('active', b.textContent === name)),
  };
}

// The usual amounts for the chosen category, as chips under the amount. Empty hides the row.
export function amountChips(onPick) {
  const node = el('div', { class: 'quick-amts hidden', role: 'group', 'aria-label': 'Usual amounts' });
  const show = (amounts) => {
    node.innerHTML = '';
    (amounts || []).forEach((a) => node.appendChild(el('button', {
      type: 'button', class: 'quick-amt', text: inr(a), onclick: () => onPick(a),
    })));
    node.classList.toggle('hidden', !(amounts && amounts.length));
  };
  return { node, show };
}

// Today and Yesterday beside the date box. A chip sets the box and fires its change event, so whatever already
// follows the date (the closed-month card note, the month a spend is counted in) follows the chip too.
export function dateChips(input, today) {
  const yest = dayShift(today, -1);
  const chip = (label, iso) => el('button', {
    type: 'button', class: 'quick-day', text: label,
    onclick: () => { input.value = iso; input.dispatchEvent(new Event('change')); },
  });
  const tBtn = chip('Today', today), yBtn = chip('Yesterday', yest);
  const sync = () => {
    const v = input.value;
    tBtn.classList.toggle('active', v === today);
    yBtn.classList.toggle('active', v === yest);
    input.classList.toggle('is-picked', !!v && v !== today && v !== yest);
  };
  input.addEventListener('change', sync);
  input.addEventListener('input', sync);
  sync();
  return el('div', { class: 'quick-days' }, [tBtn, yBtn, input]);
}

// The big amount box: a ₹ in front, and the keyboard's Done key saves.
export function bigAmount(input, onDone) {
  input.classList.add('quick-amount-in');
  input.setAttribute('enterkeyhint', 'done');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onDone(); } });
  return el('div', { class: 'quick-amount' }, [el('span', { class: 'quick-amount-cur', 'aria-hidden': 'true', text: '₹' }), input]);
}

// One quiet line that says what is left, and turns red when this entry takes it over.
export function leftLine() {
  const node = el('p', { class: 'quick-left hidden', 'aria-live': 'polite' });
  return {
    node,
    set: (text, over) => {
      node.textContent = text || '';
      node.classList.toggle('hidden', !text);
      node.classList.toggle('is-over', !!over);
    },
  };
}
// "₹2,300 left" or "₹200 over".
export const leftWords = (fmt, n) => (n < 0 ? fmt(-n) + ' over' : fmt(n) + ' left');
// "₹2,050 after this" or "₹200 over after this".
export const afterWords = (fmt, n) => (n < 0 ? fmt(-n) + ' over after this' : fmt(n) + ' after this');

// Points at what is missing instead of only saying it in a toast: a short red pulse, scrolled into view.
export function markMissing(node) {
  if (!node) return;
  node.classList.remove('is-missing');
  void node.offsetWidth;
  node.classList.add('is-missing');
  try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { /* older browsers */ }
  setTimeout(() => node.classList.remove('is-missing'), 1600);
}

// "✓ 2 added" beside the title while adding one after another.
export const addedPill = (n) => (n > 0 ? el('span', { class: 'quick-added', text: '✓ ' + n + ' added' }) : null);
