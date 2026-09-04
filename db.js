// IndexedDB data layer. All data lives on this device only.
export const DB = (function () {
  const NAME = 'mynote-stocks';
  const VERSION = 16;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('stocks')) {
          const s = db.createObjectStore('stocks', { keyPath: 'id', autoIncrement: true });
          s.createIndex('portfolio', 'portfolio', { unique: false });
        }
        if (!db.objectStoreNames.contains('snapshots')) {
          const s = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
          s.createIndex('portfolio', 'portfolio', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        // Month-keyed portfolio stats. Key is `${portfolio}|${ym}` so re-saving a
        // month overwrites it instead of creating duplicate history.
        if (!db.objectStoreNames.contains('monthly')) {
          const s = db.createObjectStore('monthly', { keyPath: 'key' });
          s.createIndex('portfolio', 'portfolio', { unique: false });
        }
        // Per-stock news + cached recommendation. Key `${portfolio}|${stockId}`
        // so reloading the same stock's news overwrites the previous entry.
        // Added in v3 — see feed.js for the entry shape.
        if (!db.objectStoreNames.contains('feed')) {
          const s = db.createObjectStore('feed', { keyPath: 'key' });
          s.createIndex('portfolio', 'portfolio', { unique: false });
        }
        // Mutual funds (separate from the stock app). One row per fund, indexed
        // by `owner` (currently only 'me'). Holds dated contributions + a monthly
        // value history — see mf.js for the record shape. Added in v4.
        if (!db.objectStoreNames.contains('funds')) {
          const s = db.createObjectStore('funds', { keyPath: 'id', autoIncrement: true });
          s.createIndex('owner', 'owner', { unique: false });
        }
        // Fixed deposits (FD ladder). One row per deposit, indexed by `owner`.
        // Holds bank/principal/rate/start+maturity dates — see fd.js for the
        // record shape and the maturity/interest calculations. Added in v5.
        if (!db.objectStoreNames.contains('fds')) {
          const s = db.createObjectStore('fds', { keyPath: 'id', autoIncrement: true });
          s.createIndex('owner', 'owner', { unique: false });
        }
        // Dividend tracker. One row per tracked stock, indexed by `market`
        // ('in' | 'us'). Holds per-calendar-year units + dividend-per-unit and the
        // historical payout months — see dividend.js for the record shape and the
        // annual/YoY analysis. Added in v6.
        if (!db.objectStoreNames.contains('dividends')) {
          const s = db.createObjectStore('dividends', { keyPath: 'id', autoIncrement: true });
          s.createIndex('market', 'market', { unique: false });
        }
        // Metals ledger (gold + silver). One row per transaction, indexed by
        // `metal` ('gold' | 'silver'). Holds grams + ₹ amount + platform; totals
        // roll up per metal — see metal.js. SGBs are NOT here (they live in the
        // `stocks` store and are only listed on the Metals SGB tab). Added in v7.
        if (!db.objectStoreNames.contains('metals')) {
          const s = db.createObjectStore('metals', { keyPath: 'id', autoIncrement: true });
          s.createIndex('metal', 'metal', { unique: false });
        }
        // Bonds ledger. One row per bond, indexed by `owner`. Holds issuer/rating/
        // invested amount/coupon rate/dates — see bonds.js for the record shape and
        // the maturity/interest calculations. Added in v8.
        if (!db.objectStoreNames.contains('bonds')) {
          const s = db.createObjectStore('bonds', { keyPath: 'id', autoIncrement: true });
          s.createIndex('owner', 'owner', { unique: false });
        }
        // Emergency Fund. THREE logical tables in one store, discriminated by
        // `kind` ('contribution' | 'target' | 'loan') — one store keeps the
        // upgrade block, the backup entry and the index count to one each, and
        // DB.byIndex('emergency','kind',…) gives each table for free. The fund's
        // INVESTMENTS are not here: they're ordinary funds/bonds/fds records
        // carrying `emergencyFund: true`, so they keep their live NAV fetch.
        // See emergency.js for the three record shapes. Added in v9.
        if (!db.objectStoreNames.contains('emergency')) {
          const s = db.createObjectStore('emergency', { keyPath: 'id', autoIncrement: true });
          s.createIndex('kind', 'kind', { unique: false });
        }
        // Bank savings accounts. One row per account, holding its CURRENT balance
        // (manually updated, not live-fetched) plus when it was last checked. No
        // index — the surface always reads the whole flat list. Added in v10.
        if (!db.objectStoreNames.contains('bankSavings')) {
          db.createObjectStore('bankSavings', { keyPath: 'id', autoIncrement: true });
        }
        // Credit cards (Expense section). One row per CARD, each carrying its own
        // `months: [{ ym, billed, paid }]` ledger. No index — the surface always
        // reads the whole flat list to build the month grid. Stored per-card
        // rather than per-month because the source sheet's column-per-month
        // layout would need a schema change every new month. Added in v11.
        if (!db.objectStoreNames.contains('creditCards')) {
          db.createObjectStore('creditCards', { keyPath: 'id', autoIncrement: true });
        }
        // Expense allocations (Expense → Allocation tab). One row per YEAR,
        // holding per-category amounts (salary, home, house exp, card, MF,
        // emergency, FD, ind stock, US stock, metal, savings). Indexed by year
        // for efficient year-range queries. Used to track how allocations change
        // and calculate step-up percentages year-over-year. Added in v12.
        if (!db.objectStoreNames.contains('allocations')) {
          const s = db.createObjectStore('allocations', { keyPath: 'id', autoIncrement: true });
          s.createIndex('year', 'year', { unique: true });
        }
        // Credit card reimbursements (Expense → Credit Card tab). One row per
        // MONTH, holding a single combined reimbursement amount shared across
        // every card billed that month — not per-card, since it represents
        // home spending logged elsewhere (folded in here until the Expense
        // tab tracks it directly), which was never naturally splittable by
        // card in the first place. keyPath IS the month string, so upserting
        // a month is a plain put() with no id lookup. Added in v13.
        if (!db.objectStoreNames.contains('ccReimbursements')) {
          db.createObjectStore('ccReimbursements', { keyPath: 'ym' });
        }
        // Monthly cash-flow sheet (Expense → Expense tab). One row per MONTH
        // holding only the figures that CAN'T be derived from another surface:
        // virtual balance, loan outgo and the month's own spending. Everything
        // else on that sheet (in-hand, home, MF, stocks, metal, card due,
        // EMI/EF) is read live from Allocation / Credit Card / Emergency, so
        // storing it here too would just let the two drift apart. keyPath IS
        // the month string, same as ccReimbursements. Added in v14.
        if (!db.objectStoreNames.contains('monthlySheet')) {
          db.createObjectStore('monthlySheet', { keyPath: 'ym' });
        }
        // Daily household spends (Expense → Tracker tab). One row per SPEND —
        // not per category — so the same category can be logged as many times
        // in a month as it actually happens, and a mistake can be deleted
        // without disturbing the rest. Indexed by `ym` because every read is
        // "this month's spends"; the category roll-up is derived, never stored.
        // Added in v15.
        if (!db.objectStoreNames.contains('spends')) {
          const s = db.createObjectStore('spends', { keyPath: 'id', autoIncrement: true });
          s.createIndex('ym', 'ym', { unique: false });
        }
        // Personal spends (Personal Finance section). A SEPARATE store from
        // `spends` rather than a flag on it: the two are measured against
        // different limits, roll up under different categories, and only the
        // household one is credited back on a card. Sharing one store would
        // mean every existing query needing a filter it does not have today,
        // which is how a household total quietly starts including a haircut.
        // Same shape and the same `ym` index. Added in v16.
        if (!db.objectStoreNames.contains('personalSpends')) {
          const s = db.createObjectStore('personalSpends', { keyPath: 'id', autoIncrement: true });
          s.createIndex('ym', 'ym', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      // A version bump can't proceed while another tab still holds the old
      // version open. Without this the promise never settles and the whole app
      // hangs on a blank screen with nothing in the console — reject with
      // something the user can act on instead.
      req.onblocked = () => reject(new Error('MyNote is open in another tab. Close the other tab(s) and reload to finish updating the local database.'));
    });
    return dbp;
  }

  function store(name, mode) {
    return open().then((db) => db.transaction(name, mode).objectStore(name));
  }

  function reqP(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  return {
    async all(name) {
      const os = await store(name, 'readonly');
      return reqP(os.getAll());
    },
    async byPortfolio(name, portfolio) {
      const os = await store(name, 'readonly');
      return reqP(os.index('portfolio').getAll(portfolio));
    },
    async byIndex(name, index, value) {
      const os = await store(name, 'readonly');
      return reqP(os.index(index).getAll(value));
    },
    async get(name, id) {
      const os = await store(name, 'readonly');
      return reqP(os.get(id));
    },
    async put(name, obj) {
      const os = await store(name, 'readwrite');
      return reqP(os.put(obj));
    },
    async del(name, id) {
      const os = await store(name, 'readwrite');
      return reqP(os.delete(id));
    },
    async clear(name) {
      const os = await store(name, 'readwrite');
      return reqP(os.clear());
    },
    // Export every store into a single plain object.
    async exportAll() {
      // `feed` is best-effort: very old backups (v2 export) won't have it, and
      // the store may not exist if the user is mid-upgrade. Don't fail the
      // whole export over a missing store.
      const [stocks, snapshots, monthly, meta, feed, funds, fds, dividends, metals, bonds, emergency, bankSavings, creditCards, allocations, ccReimbursements, monthlySheet, spends, personalSpends] = await Promise.all([
        this.all('stocks'),
        this.all('snapshots'),
        this.all('monthly'),
        this.all('meta'),
        this.all('feed').catch(() => []),
        this.all('funds').catch(() => []),
        this.all('fds').catch(() => []),
        this.all('dividends').catch(() => []),
        this.all('metals').catch(() => []),
        this.all('bonds').catch(() => []),
        this.all('emergency').catch(() => []),
        this.all('bankSavings').catch(() => []),
        this.all('creditCards').catch(() => []),
        this.all('allocations').catch(() => []),
        this.all('ccReimbursements').catch(() => []),
        this.all('monthlySheet').catch(() => []),
        this.all('spends').catch(() => []),
        this.all('personalSpends').catch(() => []),
      ]);
      return {
        app: 'mynote-stocks',
        version: VERSION,
        exportedAt: new Date().toISOString(),
        stocks,
        snapshots,
        monthly,
        meta,
        feed,
        funds,
        fds,
        dividends,
        metals,
        bonds,
        emergency,
        bankSavings,
        creditCards,
        allocations,
        ccReimbursements,
        monthlySheet,
        spends,
        personalSpends,
      };
    },
    // Replace all data with the contents of a previously exported object.
    async importAll(data) {
      if (!data || data.app !== 'mynote-stocks') {
        throw new Error('This file is not a MyNotes backup.');
      }
      await Promise.all([
        this.clear('stocks'),
        this.clear('snapshots'),
        this.clear('monthly'),
        this.clear('meta'),
        this.clear('feed').catch(() => {}),
        this.clear('funds').catch(() => {}),
        this.clear('fds').catch(() => {}),
        this.clear('dividends').catch(() => {}),
        this.clear('metals').catch(() => {}),
        this.clear('bonds').catch(() => {}),
        this.clear('emergency').catch(() => {}),
        this.clear('bankSavings').catch(() => {}),
        this.clear('creditCards').catch(() => {}),
        this.clear('allocations').catch(() => {}),
        this.clear('ccReimbursements').catch(() => {}),
        this.clear('monthlySheet').catch(() => {}),
        this.clear('spends').catch(() => {}),
        this.clear('personalSpends').catch(() => {}),
      ]);
      const tasks = [];
      (data.stocks || []).forEach((s) => tasks.push(this.put('stocks', s)));
      (data.snapshots || []).forEach((s) => tasks.push(this.put('snapshots', s)));
      (data.monthly || []).forEach((m) => tasks.push(this.put('monthly', m)));
      (data.meta || []).forEach((m) => tasks.push(this.put('meta', m)));
      // feed + funds + fds may be missing on older backups — silently skip.
      (data.feed || []).forEach((f) => tasks.push(this.put('feed', f).catch(() => {})));
      (data.funds || []).forEach((f) => tasks.push(this.put('funds', f).catch(() => {})));
      (data.fds || []).forEach((f) => tasks.push(this.put('fds', f).catch(() => {})));
      (data.dividends || []).forEach((d) => tasks.push(this.put('dividends', d).catch(() => {})));
      (data.metals || []).forEach((m) => tasks.push(this.put('metals', m).catch(() => {})));
      (data.bonds || []).forEach((b) => tasks.push(this.put('bonds', b).catch(() => {})));
      (data.emergency || []).forEach((e) => tasks.push(this.put('emergency', e).catch(() => {})));
      (data.bankSavings || []).forEach((b) => tasks.push(this.put('bankSavings', b).catch(() => {})));
      (data.creditCards || []).forEach((c) => tasks.push(this.put('creditCards', c).catch(() => {})));
      (data.allocations || []).forEach((a) => tasks.push(this.put('allocations', a).catch(() => {})));
      (data.ccReimbursements || []).forEach((r) => tasks.push(this.put('ccReimbursements', r).catch(() => {})));
      (data.monthlySheet || []).forEach((r) => tasks.push(this.put('monthlySheet', r).catch(() => {})));
      (data.spends || []).forEach((r) => tasks.push(this.put('spends', r).catch(() => {})));
      (data.personalSpends || []).forEach((r) => tasks.push(this.put('personalSpends', r).catch(() => {})));
      await Promise.all(tasks);
    },
  };
})();
