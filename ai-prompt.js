// Get AI Prompt: turns the user's own MyNotes data into a prompt they can review, edit and paste into any AI
// assistant they choose. MyNotes gives no advice itself, and SENDS NOTHING: this file makes no network request of
// any kind and is pure - raw records in, text out - so what goes into a prompt is decided here, in one place, and
// tested. Ported from the sibling mynote-app repo (ai-prompt.js).
//
// What never goes in, by construction (the summaries below simply never read these fields):
//   notes, remarks, tags and every other free-text field; card, fund and stock names; bank and account names, and an
//   account type typed before the dropdown existed; loan labels, loan "who"/"purpose" and "who has it" labels; stock
//   profile names (other profiles are numbered); payment/transaction/order ids; the anonymous name, install id and
//   the person's name; anything from Health Check or the password vault; the "wife" portfolio label.
// Amounts are rounded to whole rupees. Only the sections the user ticks are included.
//
// The figures are the app's own, so an answer never argues with what Analysis shows: spending only (refunds are
// left out, as on every Analysis tab), personal spends in the month the Personal tab counts them in, the month in
// progress marked as such, and the budget and month-end estimate the Household and Personal tabs show (worked out
// by the screen with the same helpers and handed in as plain numbers).
import { categoryMonths, categoryView } from './category-core.js';
import { computeFund } from './mf.js';
import { resolveChain } from './fd.js';
import { computeBond } from './bonds.js';
import { rollup } from './metal.js';
import { isSgb, BANK_SAV_TYPES } from './core.js';

const R = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const USD = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const pos = (n) => Math.max(0, Number(n) || 0);
const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
// "+12.5%" / "-3%": the gain on what was put in.
const gain = (invested, value) => {
  if (!(invested > 0) || value == null) return '';
  const p = Math.round(((value - invested) / invested) * 1000) / 10;
  return ' (' + (p >= 0 ? '+' : '') + p + '%)';
};
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monLabel = (ym) => {
  const m = /^(\d{4})-(\d{2})/.exec(ym || '');
  return m ? MONS[+m[2] - 1] + ' ' + m[1] : ym;
};
const dayLabel = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? (+m[3]) + ' ' + MONS[+m[2] - 1] + ' ' + m[1] : String(iso || '');
};
const daysInYm = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
const ymOf = (x) => String((x && x.ym) || '').slice(0, 7);

// The things a prompt can include. The screen lists only items that have data behind them.
export const DATA_ITEMS = [
  { id: 'income', label: 'Monthly income' },
  { id: 'household', label: 'Household spending' },
  { id: 'personal', label: 'Personal spending' },
  { id: 'categories', label: 'Spending categories' },
  { id: 'trends', label: 'Spending trends (last 6 months)' },
  { id: 'cards', label: 'Credit-card usage' },
  { id: 'loans', label: 'Existing loans (amount owed)' },
  { id: 'savings', label: 'Savings (bank balances)' },
  { id: 'investments', label: 'Investments' },
  { id: 'emergency', label: 'Emergency fund' },
  { id: 'goals', label: 'Allocation plan and goals' },
];

// What the prompt is for, and which items it starts ticked with (the user can change every tick). Each question
// names what a useful answer has to contain, so the default prompt asks for something specific.
export const PURPOSES = [
  { id: 'health', label: 'Financial health review', items: ['income', 'household', 'personal', 'cards', 'loans', 'savings', 'investments', 'emergency', 'goals'],
    ask: 'Review my overall financial health using this data: what looks solid, what looks stretched, and the first three things I should work on, with the numbers behind each.' },
  { id: 'spending', label: 'Spending analysis', items: ['household', 'personal', 'categories', 'trends'],
    ask: 'Analyse my spending: which categories and habits drive it, how this month is tracking against my usual month and my budget, and which way the trend is heading.' },
  { id: 'cards', label: 'Credit card review', items: ['cards', 'income', 'personal', 'household'],
    ask: 'Review how I use my credit cards: bills against limits and against my income, whether I pay on time, how the bills are trending, and anything that looks risky.' },
  { id: 'investments', label: 'Investment overview', items: ['investments', 'savings', 'emergency'],
    ask: 'Give me an overview of how my investments are spread across types, what that spread means for risk, liquidity and growth, and what I should keep an eye on.' },
  { id: 'goals', label: 'Savings / goal planning', items: ['income', 'goals', 'savings', 'emergency', 'household', 'personal', 'loans'],
    ask: 'Help me plan my savings goals: whether my monthly plan is realistic against what I actually spend, how far off my emergency-fund targets are, and what would get me there sooner.' },
  { id: 'reduce', label: 'Where could I reduce spending?', items: ['household', 'personal', 'categories', 'trends'],
    ask: 'Where could I reasonably reduce my spending? Point to specific categories or patterns in the data, estimate how much each could save a month, and say what you are assuming.' },
  { id: 'allocate', label: 'Where should I consider allocating my money?', items: ['income', 'savings', 'investments', 'emergency', 'goals', 'loans'],
    ask: 'What should I consider when deciding where to put my money each month? Weigh the options against my emergency fund, spending, loans and existing investments, with their risks and trade-offs, rather than telling me what to buy.' },
  { id: 'custom', label: 'Custom question', items: [], ask: '' },
];

// ---------- raw records -> safe summaries ----------
// `raw` holds the store arrays as read: spends, personalSpends, allocations, creditCards, bankSavings, stocks, funds,
// fds, metals, bonds, plus:
//   ef              the emergency-fund totals efLoad already works out (its target ladder included)
//   usdInr, rates   the cached USD rate and gold / silver ₹ per gram ({ gold, silver, asOf }), or nothing
//   today           'YYYY-MM-DD'
//   personalMonthOf the Personal tab's rule for which month a personal spend counts in (defaults to its `ym`)
//   portfolios      [{ id, cur }] - your own two stock portfolios plus any other profile counted "In total"
//   review          { house, personal } - this month's budget, estimate and flagged categories, as the tabs show them
//   loans           { count, owed } - the Balance tab's existing loans
// Every summary returns plain numbers and fixed labels, or null when there is no data.
function spendSummary(rows, monthOf, ym) {
  const months = categoryMonths(rows || [], monthOf);
  if (!months.size) return null;
  const v = categoryView(months, ym);
  const last6 = [...months.keys()].filter((k) => k <= ym).sort().slice(-6).map((k) => ({ ym: k, spent: months.get(k).spent }));
  return { ym, spent: v.spent, usual: v.usualTotal, history: v.historyMonths, cats: v.cats.filter((c) => c.amount > 0 || (c.usual || 0) > 0).slice(0, 8), last6 };
}

const GRADE = { good: 'usually close', fair: 'a fair estimate', rough: 'a rough estimate' };
const DRIVERS = ['more often', 'dearer each time'];
const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
// Only numbers and category names are copied out of what the screen hands in.
function reviewOf(x) {
  if (!x || typeof x !== 'object') return null;
  const est = numOrNull(x.estimate), lo = numOrNull(x.lo), hi = numOrNull(x.hi), byNow = numOrNull(x.usualByNow);
  return {
    budget: pos(x.budget),
    estimate: est != null && est > 0 ? est : null,
    lo: lo != null && hi != null && hi > lo ? lo : null,
    hi: lo != null && hi != null && hi > lo ? hi : null,
    grade: GRADE[x.grade] ? x.grade : null,
    usualByNow: byNow != null && byNow > 0 ? byNow : null,
    flagged: (Array.isArray(x.flagged) ? x.flagged : []).slice(0, 3).map((f) => ({
      name: String((f && f.name) || '').slice(0, 40),
      over: pos(f && f.over),
      count: Math.round(pos(f && f.count)), usualCount: Math.round(pos(f && f.usualCount)),
      nowAvg: pos(f && f.nowAvg), usualAvg: pos(f && f.usualAvg),
      driver: DRIVERS.includes(f && f.driver) ? f.driver : null,
    })).filter((f) => f.name && f.over > 0),
  };
}

// The Allocation tab's lines, in its order, with the names written out.
const PLAN_LINES = [['home', 'Parents'], ['houseExp', 'House expenses (the household budget)'], ['card', 'Personal spending (card allowance)'],
  ['emergency', 'Emergency fund'], ['mf', 'Mutual funds'], ['fd', 'Fixed deposits'], ['indStock', 'Indian stocks'], ['usStock', 'US stocks'],
  ['metal', 'Gold & silver'], ['savings', 'Savings']];
const OWN_PORTS = [{ id: 'me-in', cur: 'INR' }, { id: 'me-us', cur: 'USD' }];

export function summarise(raw) {
  const r = raw || {};
  const today = /^\d{4}-\d{2}-\d{2}$/.test(r.today || '') ? r.today : new Date().toISOString().slice(0, 10);
  const ym = today.slice(0, 7);
  const year = Number(today.slice(0, 4));
  const nowMs = Date.parse(today);
  const out = { today, ym, day: Number(today.slice(8, 10)), dim: daysInYm(ym) };

  const alloc = (r.allocations || []).find((a) => a && Number(a.year) === year) || null;
  if (alloc && pos(alloc.salary) > 0) out.income = { salary: pos(alloc.salary) };
  if (alloc) {
    const lines = PLAN_LINES.map(([k, label]) => ({ label, amount: pos(alloc[k]) })).filter((l) => l.amount > 0);
    if (lines.length) {
      out.plan = { year, lines, assigned: lines.reduce((s, l) => s + l.amount, 0), shared: alloc.sharedOn ? pos(alloc.sharedAmount) : 0 };
    }
  }

  // Spending only: a refund (a negative amount) is left out, as on every Analysis tab.
  const spendsOf = (rows) => (rows || []).filter((x) => x && Number(x.amount) > 0);
  out.household = spendSummary(spendsOf(r.spends), ymOf, ym);
  // Own spending only (money fronted for somebody who pays it back is left out, as on Limits), in the month the
  // Personal tab counts it in: a card spend lands on the statement it is billed on.
  const pfMonth = typeof r.personalMonthOf === 'function'
    ? (x) => { try { return String(r.personalMonthOf(x) || '').slice(0, 7); } catch (_) { return ymOf(x); } }
    : ymOf;
  out.personal = spendSummary(spendsOf(r.personalSpends).filter((x) => !x.forOthers), pfMonth, ym);
  const rv = r.review || {};
  if (out.household) out.household.review = reviewOf(rv.house);
  if (out.personal) out.personal.review = reviewOf(rv.personal);

  const cards = (r.creditCards || []).map((c, i) => {
    const bills = ((c && c.months) || []).filter((m) => m && pos(m.billed) > 0 && ymOf(m) && ymOf(m) <= ym)
      .sort((a, b) => ymOf(a).localeCompare(ymOf(b))).slice(-3)
      .map((m) => ({ ym: ymOf(m), billed: pos(m.billed), status: m.status === 'ontime' || m.status === 'late' ? m.status : null }));
    return { label: 'Card ' + (i + 1), limit: pos(c && c.creditLimit), bills };
  }).filter((c) => c.limit > 0 || c.bills.length);
  if (cards.length) out.cards = cards;

  if (r.loans && Math.round(pos(r.loans.count)) > 0) out.loans = { count: Math.round(pos(r.loans.count)), owed: pos(r.loans.owed) };

  const banks = (r.bankSavings || []).filter(Boolean);
  if (banks.length) {
    const byType = new Map();
    // An account is named only by its type from the fixed list; anything typed before the list existed is "Other".
    banks.forEach((b) => { const t = BANK_SAV_TYPES.includes(b.label) ? b.label : (b.label ? 'Other' : 'Type not set'); byType.set(t, (byType.get(t) || 0) + pos(b.balance)); });
    out.savings = { total: banks.reduce((s, b) => s + pos(b.balance), 0), accounts: banks.length, byType: [...byType].map(([type, amount]) => ({ type, amount })).sort((a, b) => b.amount - a.amount) };
  }

  // ---- Investments. `cls` is the asset class the split is worked out by; `value` null = no current value known.
  const inv = [];
  const usdInr = pos(r.usdInr);
  const ports = (Array.isArray(r.portfolios) && r.portfolios.length ? r.portfolios : OWN_PORTS).filter((p) => p && typeof p.id === 'string');
  const portIds = new Set(ports.map((p) => p.id));
  const live = (r.stocks || []).filter((s) => s && s.status !== 'sold' && portIds.has(s.portfolio));
  let profileNo = 1;
  ports.forEach((p) => {
    const rows = live.filter((s) => s.portfolio === p.id && !isSgb(s));
    if (!rows.length) return;
    const usd = p.cur ? p.cur === 'USD' : /-us$/.test(p.id);
    const own = p.id === 'me-in' || p.id === 'me-us';
    const fx = usd ? (usdInr > 0 ? usdInr : null) : 1;
    let invested = 0, value = 0, noPrice = 0;
    rows.forEach((s) => {
      const u = pos(s.units), buy = pos(s.buyPrice), cur = pos(s.currentPrice);
      invested += u * buy; value += u * (cur || buy);
      if (!cur) noPrice++;
    });
    inv.push({ cls: usd ? 'US stocks' : 'Indian stocks', label: (usd ? 'US stocks' : 'Indian stocks') + (own ? '' : ' (profile ' + (++profileNo) + ')'),
      count: rows.length, invested: fx ? invested * fx : invested, value: fx ? value * fx : value, usd: usd && !fx, fx: usd && fx ? fx : null, noPrice, unit: 'holding' });
  });
  // Sovereign gold bonds sit in the stocks store but are gold (the app's own rule), so they get their own line.
  const sgbs = live.filter(isSgb);
  if (sgbs.length) {
    let invested = 0, value = 0, noPrice = 0;
    sgbs.forEach((s) => { const u = pos(s.units), buy = pos(s.buyPrice), cur = pos(s.currentPrice); invested += u * buy; value += u * (cur || buy); if (!cur) noPrice++; });
    inv.push({ cls: 'Gold & silver', label: 'Sovereign Gold Bonds', count: sgbs.length, invested, value, noPrice, unit: 'holding' });
  }
  // The same records the app counts: your own, not sold, and not linked to the Emergency Fund (listed there).
  const mine = (x) => x && x.owner === 'me' && !x.emergencyFund;
  const funds = (r.funds || []).filter((f) => mine(f) && f.status !== 'Sold' && !f.soldDate);
  if (funds.length) {
    let invested = 0, value = 0, sip = 0;
    const byCat = new Map(), byKind = new Map();
    funds.forEach((f) => {
      try {
        const c = computeFund(f, nowMs);
        invested += pos(c.invested); value += pos(c.value);
        const cat = String(f.category || 'Other').slice(0, 30), kind = String(f.type || '').slice(0, 30);
        byCat.set(cat, (byCat.get(cat) || 0) + pos(c.value));
        if (kind) byKind.set(kind, (byKind.get(kind) || 0) + pos(c.value));
      } catch (_) { /* a fund that cannot be computed is left out */ }
      if (/^investing/i.test(String(f.status || ''))) sip += pos(f.sip);
    });
    const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
    inv.push({ cls: 'Mutual funds', label: 'Mutual funds', count: funds.length, invested, value, sip, unit: 'fund',
      cats: top(byCat, 4).map(([name, amount]) => ({ name, amount })), kinds: top(byKind, 6).map(([name]) => name) });
  }
  const fdRecs = (r.fds || []).filter((f) => f && f.owner === 'me');
  if (fdRecs.length) {
    // Through the chain, so a rolled-over deposit carries the money rolled into it.
    const byId = new Map(fdRecs.map((f) => [f.id, f])), cache = new Map();
    const active = fdRecs.filter((f) => !f.emergencyFund)
      .map((f) => { try { return resolveChain(f, byId, nowMs, cache); } catch (_) { return null; } })
      .filter((c) => c && c.effectiveStatus === 'active');
    if (active.length) {
      const principal = active.reduce((s, c) => s + pos(c.principal), 0);
      const soon = active.filter((c) => c.daysToMaturity != null && c.daysToMaturity <= 90);
      inv.push({ cls: 'Fixed deposits', label: 'Fixed deposits', count: active.length, invested: principal, value: active.reduce((s, c) => s + pos(c.currentValue), 0),
        avgRate: principal > 0 ? active.reduce((s, c) => s + pos(c.principal) * pos(c.rate), 0) / principal : 0, unit: 'deposit',
        soon: soon.length ? { count: soon.length, amount: soon.reduce((s, c) => s + pos(c.maturityValue), 0), first: soon.map((c) => c.maturity).filter(Boolean).sort()[0] || null } : null });
    }
  }
  const metals = r.metals || [];
  const rates = r.rates || {};
  ['gold', 'silver'].forEach((m) => {
    // rollup: a sell takes out the cost of the grams sold, and interest grams are free - neither is money paid.
    const { grams, invested } = rollup(metals, m);
    if (!(grams > 0)) return;
    const rate = pos(rates[m]);
    const asOfMs = rates.asOf ? Date.parse(rates.asOf) : null;
    inv.push({ cls: 'Gold & silver', label: m === 'gold' ? 'Gold' : 'Silver', grams: Math.round(grams * 1000) / 1000, invested: pos(invested),
      value: rate > 0 ? grams * rate : null, rate: rate > 0 ? rate : null, asOf: rates.asOf ? String(rates.asOf).slice(0, 10) : null,
      // Older than a week: still shown (it's what the value was actually worked out from), but flagged rather
      // than presented as today's rate.
      stale: asOfMs != null && Number.isFinite(asOfMs) && (nowMs - asOfMs) > 7 * 86400000 });
  });
  const bonds = (r.bonds || []).filter(mine)
    .map((b) => { try { return computeBond(b, nowMs); } catch (_) { return null; } })
    .filter((c) => c && c.effectiveStatus === 'active' && pos(c.outstandingPrincipal) > 0);
  if (bonds.length) {
    const principal = bonds.reduce((s, c) => s + pos(c.outstandingPrincipal), 0);
    inv.push({ cls: 'Bonds', label: 'Bonds', count: bonds.length, invested: principal, value: null, unit: 'bond',
      avgRate: principal > 0 ? bonds.reduce((s, c) => s + pos(c.outstandingPrincipal) * pos(c.rate), 0) / principal : 0 });
  }
  if (inv.length) out.investments = inv;

  if (r.ef && (pos(r.ef.fundValue) > 0 || (r.ef.targets || []).length)) {
    const e = r.ef;
    const value = pos(e.fundValue), lentOut = pos(e.lentOut);
    // One basis for every target and for the headline "available" figure, so they can never disagree: the
    // Emergency Fund screen's own ladder is measured against `corpusIn` (money ever taken in - a different,
    // usually smaller, number than the fund's current value), which is why a target used to say a different
    // % "there" than the "available" figure right next to it. Here it is always `available` (value - lent
    // out) - never the raw record's own isMet/pct/remaining, which were worked out on that other basis.
    const available = Math.max(0, value - lentOut);
    const targets = (e.targets || []).map((t) => {
      const amount = pos(t && (t.cumulative != null ? t.cumulative : t.amount));
      return {
        amount,
        met: amount > 0 && available >= amount,
        pct: amount > 0 ? Math.min(100, (available / amount) * 100) : 0,
        left: Math.max(0, amount - available),
      };
    }).filter((t) => t.amount > 0);
    out.emergency = { value, lentOut, available, cash: e.cashInHand != null ? pos(e.cashInHand) : null,
      parked: e.parkedValue != null ? pos(e.parkedValue) : null, overdue: Math.round(pos(e.overdueCount)), targets };
  }
  return out;
}

// What a purpose is built around but this device cannot offer (no data yet) - shown under the purpose chips so a
// weaker prompt is not a surprise. Labels only, in the list's own order.
export function purposeGaps(purposeId, avail) {
  const p = PURPOSES.find((x) => x.id === purposeId);
  if (!p) return [];
  const have = new Set(avail || []);
  return DATA_ITEMS.filter((it) => p.items.includes(it.id) && !have.has(it.id)).map((it) => it.label);
}

// Which items have something behind them, given the summary.
export function availableItems(summary) {
  const has = {
    income: !!summary.income, household: !!summary.household, personal: !!summary.personal,
    categories: !!(summary.household || summary.personal), trends: !!((summary.household && summary.household.last6.length > 1) || (summary.personal && summary.personal.last6.length > 1)),
    cards: !!summary.cards, loans: !!summary.loans, savings: !!summary.savings, investments: !!summary.investments, emergency: !!summary.emergency,
    goals: !!(summary.plan || (summary.emergency && summary.emergency.targets.length)),
  };
  return DATA_ITEMS.filter((it) => has[it.id]).map((it) => it.id);
}

// ---------- the prompt text ----------
const driverText = (f) => (f.driver === 'more often'
  ? ', more often (' + plural(f.count, 'time') + ' this month against a usual ' + f.usualCount + ')'
  : f.driver === 'dearer each time' ? ', dearer each time (' + R(f.nowAvg) + ' a time against a usual ' + R(f.usualAvg) + ')' : '');

const spendLines = (title, sp, withCats, withTrend, t, monthDone) => {
  const lowConf = sp.usual != null && sp.history > 0 && sp.history < 3
    ? ' Based on only ' + sp.history + ' earlier month' + (sp.history === 1 ? '' : 's') + ', so treat any usual-month comparison here as low-confidence.' : '';
  const lines = [title + ', ' + monLabel(sp.ym) + (monthDone ? ' (the full month)' : ' so far (day ' + t.day + ' of ' + t.dim + ')') + ': ' + R(sp.spent) + ' spent. '
    + (sp.usual != null ? 'A usual full month is ' + R(sp.usual) + (sp.history === 1 ? ' (from only 1 earlier month).' : ' (the median of the last ' + sp.history + ' months with spending).')
      : 'Not enough history yet for a usual month.') + lowConf];
  if (withCats && sp.cats.length) {
    lines.push('  By category' + (monthDone ? ' (the full month)' : ' this month so far') + (sp.usual != null ? ' (a usual month in brackets)' : '') + ':');
    sp.cats.forEach((c) => lines.push('  - ' + c.name + ': ' + R(c.amount) + (c.usual == null ? '' : c.usual > 0 ? ' (usual ' + R(c.usual) + ')' : ' (usually none)')));
    const fl = sp.review && sp.review.flagged;
    if (fl && fl.length) {
      lines.push('  Flagged by MyNotes as above their usual this month (against the median of all earlier months):');
      fl.forEach((f) => lines.push('  - ' + f.name + ': ' + R(f.over) + ' above usual' + driverText(f)));
    }
  }
  if (withTrend && sp.last6.length > 1) {
    const full = sp.last6.filter((m) => m.ym !== sp.ym), cur = sp.last6.find((m) => m.ym === sp.ym);
    lines.push('  Monthly totals: ' + full.map((m) => monLabel(m.ym) + ' ' + R(m.spent)).join(', ')
      + (cur ? (full.length ? '; ' : '') + monLabel(cur.ym) + ' so far ' + R(cur.spent) : '') + '.');
  }
  return lines;
};

// One line per side for KEY FIGURES: spent against the budget, the days left, and the app's own estimate.
const budgetLine = (name, word, sp, left, t, monthDone) => {
  const rv = sp.review;
  let head = name + ' this month: ' + R(sp.spent) + ' spent';
  if (rv && rv.budget > 0) {
    const over = sp.spent - rv.budget;
    head += ' of the ' + R(rv.budget) + ' ' + word + ' (' + pctOf(sp.spent, rv.budget) + '%), ' + (over > 0 ? R(over) + ' over' : R(-over) + ' left');
  } else if (rv) head += ' (no ' + word + ' set)';
  const bits = [head];
  // Pacing figures (days left, where a usual month stands today, a linear fallback projection) only mean
  // something while the month is still running - on or after its last day there is no "pace" left to judge.
  if (!monthDone) {
    bits.push(plural(left, 'day') + ' left, today included');
    if (rv && rv.usualByNow != null) bits.push('a usual month has ' + R(rv.usualByNow) + ' spent by this day');
  }
  if (rv && rv.estimate != null) {
    bits.push('MyNotes estimates about ' + R(rv.estimate) + ' by month end' + (rv.lo != null ? ' (' + R(rv.lo) + ' to ' + R(rv.hi) + ')' : '') + (rv.grade ? ', ' + GRADE[rv.grade] : ''));
  } else if (!monthDone && sp.spent > 0 && t && t.day > 0) {
    // No graded estimate for this side yet (too little history): a plain linear fallback, clearly labelled as
    // one, rather than nothing at all.
    const projected = Math.round(sp.spent / t.day * t.dim);
    bits.push('a simple projection (spent so far ÷ day × days in month) suggests about ' + R(projected) + ' by month end');
  }
  // A budget set noticeably below what a usual month actually costs is worth saying plainly - it is the
  // budget, not the month, that looks unrealistic, and a reader should not have to spot the gap themselves.
  if (rv && rv.budget > 0 && sp.usual != null && sp.usual > 0 && rv.budget < sp.usual * 0.8) {
    bits.push(R(rv.budget) + ' ' + word + ' is ' + pctOf(sp.usual - rv.budget, sp.usual) + '% below a usual month of ' + R(sp.usual));
  }
  return bits.join('; ') + '.';
};

const BILL_STATUS = { ontime: 'paid on time', late: 'paid late' };
const invAmount = (i, n) => (i.usd ? USD(n) : R(n));
const soonWhen = (soon) => (soon.first ? ' (' + (soon.count === 1 ? 'on ' : 'the first on ') + dayLabel(soon.first) + ')' : '');
// The rate exactly as the value was worked out from it - R() rounds to a whole rupee, which for a rate like
// 225.47/g would show "₹225/g" right next to a value that was actually grams × 225.47, not grams × 225.
const fmtRate = (n) => (Number.isInteger(n) ? R(n) : '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// Income, exact or a privacy-preserving range (the person's own choice on the AI Prompt screen). A range is never
// a stored fact: summarise() always reports the exact salary; this only decides how buildPrompt is allowed to
// describe it below.
const incPct = (amt, inc) => (inc.salary != null ? pctOf(amt, inc.salary) + '%' : pctOf(amt, inc.hi) + '% to ' + pctOf(amt, inc.lo) + '%');
const incTimes = (amt, inc) => {
  const r1 = (n) => Math.round(n * 10) / 10;
  return inc.salary != null ? r1(amt / inc.salary) + ' times' : r1(amt / inc.hi) + ' to ' + r1(amt / inc.lo) + ' times';
};
const incLabel = (inc) => (inc.salary != null ? R(inc.salary) : R(inc.lo) + '–' + R(inc.hi) + ' (given as a range)');

const invLine = (i) => {
  if (i.grams != null) {
    return '- ' + i.label + ': ' + i.grams + ' g, ' + R(i.invested) + ' paid'
      + (i.value != null ? ', about ' + R(i.value) + ' now at MyNotes’ saved rate of ' + fmtRate(i.rate) + '/g'
        + (i.asOf ? ' (as of ' + dayLabel(i.asOf) + (i.stale ? ' — may be stale' : '') + ')' : '')
        : ' (current value not included: no saved ' + i.label.toLowerCase() + ' rate)') + '.';
  }
  let t = '- ' + i.label + ': ' + plural(i.count, i.unit || 'holding') + ', ';
  if (i.cls === 'Fixed deposits') {
    t += R(i.invested) + ' principal, about ' + R(i.value) + ' now, average rate ' + (Math.round(i.avgRate * 100) / 100) + '%';
    if (i.soon) t += '; ' + R(i.soon.amount) + ' comes back from ' + plural(i.soon.count, 'deposit') + ' maturing in the next 90 days' + soonWhen(i.soon);
  } else if (i.cls === 'Bonds') {
    t += R(i.invested) + ' principal outstanding, average rate ' + (Math.round(i.avgRate * 100) / 100) + '% (current market value not recorded)';
  } else if (!(i.invested > 0) && !(i.value > 0)) {
    t += 'no amounts recorded yet';
  } else if (i.noPrice && i.noPrice === i.count) {
    t += invAmount(i, i.invested) + ' invested (no current prices saved, so counted at cost)';
    if (i.usd) t += ', in US dollars (no exchange rate saved)';
    if (i.fx) t += ', converted at ' + R(i.fx) + ' per US dollar';
  } else {
    t += invAmount(i, i.invested) + ' invested, about ' + invAmount(i, i.value) + ' now' + gain(i.invested, i.value);
    if (i.usd) t += ', in US dollars (no exchange rate saved)';
    if (i.fx) t += ', converted at ' + R(i.fx) + ' per US dollar';
    if (i.noPrice) t += '; ' + i.noPrice + ' with no current price, counted at cost';
    const cats = (i.cats || []).filter((c) => c.amount > 0);
    if (cats.length) t += '; by category: ' + cats.map((c) => c.name + ' ' + R(c.amount)).join(', ');
    if (i.kinds && i.kinds.length) t += '; kinds: ' + i.kinds.join(', ');
    if (i.sip > 0) t += '; SIPs ' + R(i.sip) + ' a month';
  }
  return t + '.';
};

// `summary` from summarise(); `items` the ticked ids; `purpose` a PURPOSES id; `question` the user's own words.
// `incomeMode`/`incomeRange`: how the "income" item, when ticked, states the salary - 'exact' (default,
// unchanged) or 'range' with a { lo, hi } the person typed, so they can include the shape of their income
// (for ratios and percentages) without the prompt carrying the exact figure.
export function buildPrompt({ summary, items, purpose, question, incomeMode, incomeRange }) {
  const pick = new Set(items || []);
  const p = PURPOSES.find((x) => x.id === purpose) || PURPOSES[PURPOSES.length - 1];
  const s = summary || {};
  const today = s.today || new Date().toISOString().slice(0, 10);
  const t = { day: s.day || Number(today.slice(8, 10)), dim: s.dim || daysInYm(today.slice(0, 7)) };
  const left = Math.max(0, t.dim - t.day + 1);
  // On, or after, the month's last calendar day there is no "pace" left to judge it by - treat it as a
  // completed month rather than an in-progress one still being paced.
  const monthDone = t.day >= t.dim;

  // What goes in: a section only when it is ticked and has data. Categories and trends are details of the two
  // spending sections; ticked without either side, they bring both sides in.
  const detailOnly = !pick.has('household') && !pick.has('personal') && (pick.has('categories') || pick.has('trends'));
  const house = (pick.has('household') || detailOnly) && s.household ? s.household : null;
  const own = (pick.has('personal') || detailOnly) && s.personal ? s.personal : null;
  const rawInc = pick.has('income') && s.income ? s.income : null;
  const validRange = incomeMode === 'range' && incomeRange && pos(incomeRange.lo) > 0 && pos(incomeRange.hi) > pos(incomeRange.lo);
  const inc = rawInc ? (validRange ? { lo: pos(incomeRange.lo), hi: pos(incomeRange.hi) } : { salary: rawInc.salary }) : null;
  const plan = pick.has('goals') && s.plan ? s.plan : null;
  const cards = pick.has('cards') && s.cards ? s.cards : null;
  const loans = pick.has('loans') && s.loans ? s.loans : null;
  const sav = pick.has('savings') && s.savings ? s.savings : null;
  const invs = pick.has('investments') && s.investments ? s.investments : null;
  const ef = pick.has('emergency') && s.emergency ? s.emergency : null;
  const efTargets = !ef && pick.has('goals') && s.emergency && s.emergency.targets.length ? s.emergency.targets : null;

  const L = [];
  L.push('I use a personal finance app called MyNotes. Below is data I recorded myself in it (India, amounts in rupees). '
    + 'It is user-provided and may be incomplete. Today is ' + dayLabel(today) + '.');
  L.push('');
  L.push('HOW TO WORK WITH THIS DATA');
  L.push('- Analyse only the information provided, and identify patterns and observations.');
  L.push('- Use my numbers: quote the ₹ amount or % behind every point, and show the working for anything you calculate.');
  if (house || own) {
    L.push(monthDone
      ? '- ' + MONTHS[Number(today.slice(5, 7)) - 1] + ' is complete (today is its last day): judge it as a full month, not by pace.'
      : '- ' + MONTHS[Number(today.slice(5, 7)) - 1] + ' is in progress (day ' + t.day + ' of ' + t.dim + '): judge this month on its pace so far, and use only the completed months for trends.');
  }
  L.push('- Explain any assumptions you make, and do not assume information that is missing - ask me clarifying questions instead.');
  L.push('- Keep facts (what the data shows) separate from suggestions (what I might consider).');
  L.push('- If you discuss investments, explain the risks and trade-offs involved. Talk about kinds of product (for example "a liquid fund" or '
    + '"a short FD"), not named stocks, funds or cards, and don’t promise returns.');
  L.push('- Where Indian tax rules could change the answer, say what I should check rather than guessing my tax position.');
  L.push('- I want general, educational guidance, not certainty or personalised financial advice - but tie every point to my numbers, not generic tips.');

  // ---- Figures the app has already worked out, from the ticked sections only.
  const K = [];
  if (inc && plan) {
    if (inc.salary != null) {
      const un = inc.salary - plan.assigned;
      K.push('Allocation plan: ' + R(plan.assigned) + ' of the ' + R(inc.salary) + ' monthly take-home is assigned (' + pctOf(plan.assigned, inc.salary) + '%); '
        + (un >= 0 ? R(un) + ' is not assigned to any line.' : 'the plan is ' + R(-un) + ' more than the take-home.'));
    } else {
      K.push('Allocation plan: ' + R(plan.assigned) + ' assigned, ' + incPct(plan.assigned, inc) + ' of a ' + incLabel(inc) + ' monthly take-home.');
    }
  }
  const usualSides = [[house, 'household'], [own, 'personal']].filter(([x]) => x && x.usual != null);
  const usualSpend = usualSides.reduce((a, [x]) => a + x.usual, 0);
  const usualParts = usualSides.length > 1 ? ' (' + usualSides.map(([x, n]) => n + ' ' + R(x.usual)).join(' + ') + ')' : '';
  // With only one side of spending in the prompt, every figure built on it says so - otherwise a months-of-cover
  // or savings-rate figure reads as if it covered all spending, and comes out rosier than it is.
  const oneSide = usualSides.length === 1 ? usualSides[0][1] : null;
  const otherSide = oneSide === 'household' ? 'personal' : 'household';
  const spendWord = oneSide ? oneSide + ' spending only' : 'spending';
  const partialNote = oneSide ? ' (' + otherSide + ' spending is not included, so the real figure is lower)' : '';
  if (inc && usualSpend > 0) {
    K.push('Recorded ' + spendWord + ' in a usual month: ' + R(usualSpend) + usualParts + ', ' + incPct(usualSpend, inc) + ' of the take-home.');
    // Savings rate: take-home less usual spending, as a % of take-home - new, and only where an income figure
    // (exact or range) exists to measure it against.
    if (inc.salary != null) {
      K.push('Savings rate: about ' + Math.round(((inc.salary - usualSpend) / inc.salary) * 100) + '% of take-home, based on a usual month\'s ' + spendWord + partialNote + '.');
    } else {
      const lo = Math.round(((inc.lo - usualSpend) / inc.lo) * 100), hi = Math.round(((inc.hi - usualSpend) / inc.hi) * 100);
      K.push('Savings rate: about ' + Math.min(lo, hi) + '% to ' + Math.max(lo, hi) + '% of take-home, based on a usual month\'s ' + spendWord + partialNote + '.');
    }
  }
  if (house) K.push(budgetLine('Household', 'budget', house, left, t, monthDone));
  if (own) K.push(budgetLine('Personal', 'allowance', own, left, t, monthDone));
  (cards || []).forEach((c) => {
    if (!c.bills.length) return;
    const last = c.bills[c.bills.length - 1];
    const late = c.bills.filter((b) => b.status === 'late').length, onTime = c.bills.filter((b) => b.status === 'ontime').length;
    K.push(c.label + ': the ' + monLabel(last.ym) + ' bill of ' + R(last.billed) + (c.limit > 0 ? ' is ' + pctOf(last.billed, c.limit) + '% of the limit' : ' (no limit recorded)')
      + '; of the last ' + plural(c.bills.length, 'bill') + ', ' + onTime + ' paid on time' + (late ? ' and ' + late + ' paid late' : '') + '.');
  });
  if (loans) {
    K.push('Existing loans: ' + plural(loans.count, 'loan') + ', ' + R(loans.owed) + ' still owed'
      + (inc ? ' (' + incTimes(loans.owed, inc) + ' the monthly take-home)' : '') + '.');
  }
  if (ef) {
    const cover = usualSpend > 0 ? Math.round((ef.available / usualSpend) * 10) / 10 : null;
    // Whether Investments (above) and the emergency fund could look like they double-count the same money:
    // they never do (linked funds/FDs/bonds are excluded from Investments by construction), but it needs
    // saying, because a reader can't see that exclusion from the numbers alone.
    const noDouble = ef.parked > 0 && invs ? '; ' + R(ef.parked) + ' of this is in linked investments (funds/FDs/bonds), already left out of the Investments figures above' : '';
    K.push('Emergency fund: ' + R(ef.value) + (ef.lentOut ? ', of which ' + R(ef.lentOut) + ' is lent out, so ' + R(ef.available) + ' is available' : '')
      + (cover != null ? '; that covers about ' + cover + ' months of my usual recorded ' + spendWord + ' (' + R(usualSpend) + ' a month)'
        + (oneSide ? ' - ' + otherSide + ' spending is not included, so the real cover is shorter' : '') : '') + noDouble + '.');
    const next = ef.targets.find((x) => !x.met);
    if (next) K.push('Next emergency-fund target: ' + R(next.amount) + ', ' + Math.floor(next.pct) + '% there, ' + R(next.left)
      + ' to go (measured against the ' + R(ef.available) + ' available, not the full ' + R(ef.value) + ').');
  }
  if (invs) {
    const inr = invs.filter((i) => !i.usd);
    const invested = inr.reduce((a, i) => a + i.invested, 0);
    const value = inr.reduce((a, i) => a + (i.value != null ? i.value : i.invested), 0);
    const atCost = inr.filter((i) => i.value == null).map((i) => i.label);
    if (invested > 0) {
      K.push('Investments: about ' + R(value) + ' now against ' + R(invested) + ' put in' + gain(invested, value)
        + (atCost.length ? '; ' + atCost.join(' and ') + ' counted at cost' : '')
        + (invs.some((i) => i.usd) ? '; US stocks held in dollars are not in these totals' : '') + '.');
      const byCls = new Map();
      inr.forEach((i) => { const v = i.value != null ? i.value : i.invested; if (v > 0) byCls.set(i.cls, (byCls.get(i.cls) || 0) + v); });
      if (byCls.size > 1) {
        K.push('Investment split by value: ' + [...byCls].sort((a, b) => b[1] - a[1])
          .map(([k, v]) => k + ' ' + (pctOf(v, value) || '<1') + '%').join(', ') + '.');
      }
    }
    const mf = invs.find((i) => i.sip > 0);
    if (mf) K.push('Monthly SIPs: ' + R(mf.sip) + (inc ? ' (' + incPct(mf.sip, inc) + ' of the take-home)' : '') + '.');
    const fd = invs.find((i) => i.soon);
    if (fd) K.push(R(fd.soon.amount) + ' from fixed deposits matures in the next 90 days' + soonWhen(fd.soon) + '.');
  }
  if (K.length) {
    L.push('');
    L.push('KEY FIGURES (worked out by MyNotes)');
    K.forEach((x) => L.push('- ' + x));
  }

  L.push('');
  L.push('MY DATA');
  const sections = [];
  if (inc) sections.push(['Monthly income', ['Take-home salary: ' + incLabel(inc) + ' a month.']]);
  if (house) sections.push(['Household spending', spendLines('Household spending', house, pick.has('categories'), pick.has('trends'), t, monthDone)]);
  if (own) sections.push(['Personal spending', spendLines('My own spending', own, pick.has('categories'), pick.has('trends'), t, monthDone)]);
  if (cards) {
    sections.push(['Credit cards', cards.map((c) => '- ' + c.label + ': limit ' + (c.limit ? R(c.limit) : 'not recorded')
      + (c.bills.length ? '; recent bills ' + c.bills.map((b) => monLabel(b.ym) + ' ' + R(b.billed) + ' (' + (BILL_STATUS[b.status] || 'not marked paid yet') + ')').join(', ') : '; no bills recorded') + '.')]);
  }
  if (loans) sections.push(['Existing loans', ['- ' + plural(loans.count, 'loan') + ' still open, ' + R(loans.owed) + ' owed in total. The type, interest rate and EMI of each loan are not recorded.']]);
  if (sav) {
    sections.push(['Savings', ['Bank balances: ' + R(sav.total) + ' across ' + plural(sav.accounts, 'account') + '.',
      ...sav.byType.map((x) => '- ' + x.type + ': ' + R(x.amount))]]);
  }
  if (invs) sections.push(['Investments', invs.map(invLine)]);
  const targetText = (list) => list.map((x) => R(x.amount) + (x.met ? ' (reached)' : ' (' + Math.floor(x.pct) + '% there, ' + R(x.left) + ' to go)')).join(', ');
  if (ef) {
    const parts = [ef.cash != null ? R(ef.cash) + ' cash' : null, ef.parked ? R(ef.parked) + ' in linked investments' : null, ef.lentOut ? R(ef.lentOut) + ' lent out' : null].filter(Boolean);
    sections.push(['Emergency fund', ['Current value: ' + R(ef.value) + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '.'
      + (ef.overdue ? ' ' + plural(ef.overdue, 'loan') + ' from it ' + (ef.overdue === 1 ? 'is' : 'are') + ' overdue.' : '')
      + (ef.targets.length ? ' Targets: ' + targetText(ef.targets) + '.' : '')]]);
  }
  if (plan || efTargets) {
    const lines = plan ? plan.lines.map((l) => '- ' + l.label + ': ' + R(l.amount)) : [];
    if (plan) lines.push('Total assigned: ' + R(plan.assigned) + ' a month.');
    if (plan && plan.shared > 0) lines.push('Others put ' + R(plan.shared) + ' a month into the household budget.');
    if (efTargets) lines.push('Emergency-fund targets: ' + targetText(efTargets) + '.');
    sections.push([plan ? 'Allocation plan for ' + plan.year + ' (monthly amounts)' : 'Goals', lines]);
  }
  if (!sections.length) L.push('(No data selected.)');
  sections.forEach(([title, lines]) => { L.push(''); L.push(title.toUpperCase()); lines.forEach((x) => L.push(x)); });

  // What is not here, so a missing section is asked about rather than read as zero.
  const inPrompt = new Set(pick);
  if (detailOnly) { inPrompt.add('household'); inPrompt.add('personal'); }
  const missing = DATA_ITEMS.filter((it) => !inPrompt.has(it.id)).map((it) => it.label);
  L.push('');
  L.push('NOT IN THIS PROMPT');
  if (missing.length) L.push('Left out: ' + missing.join(', ') + '. Don’t treat anything left out as zero - ask me if it matters.');
  L.push('MyNotes does not record insurance, tax details, or the interest rate and EMI of each loan.');

  L.push('');
  L.push('MY QUESTION');
  const q = String(question || '').trim();
  L.push(q || p.ask || 'Please review the data above and tell me what stands out.');
  if (q && p.ask) { L.push(''); L.push('Context: ' + p.ask); }

  L.push('');
  L.push('HOW TO ANSWER');
  L.push('Use these headings, in this order, and keep it practical:');
  L.push('1. Short answer - two or three lines that answer my question directly.');
  L.push('2. Key numbers - the 3 to 5 figures from my data that matter most here.');
  L.push('3. Going well - what the data shows is working, with the numbers.');
  L.push('4. Needs attention - ranked by how much money is involved, with the ₹ amount for each.');
  L.push('5. What to do - up to 5 concrete steps, each with an amount or a limit and when to do it.');
  L.push('6. What not to do - up to 5 specific things to avoid, each tied to something in my data.');
  L.push('7. Questions for me - only the ones whose answers would change your advice.');
  return L.join('\n');
}

export const PRIVACY_NOTE = 'MyNotes generated this prompt from your selected data. Check the contents and remove anything you don’t want '
  + 'to share before sending it to an AI service. Your prompt may contain financial information. Review it before sharing.';
