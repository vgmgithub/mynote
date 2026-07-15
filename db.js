// IndexedDB data layer. All data lives on this device only.
export const DB = (function () {
  const NAME = 'mynote-stocks';
  const VERSION = 6;
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
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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
      const [stocks, snapshots, monthly, meta, feed, funds, fds, dividends] = await Promise.all([
        this.all('stocks'),
        this.all('snapshots'),
        this.all('monthly'),
        this.all('meta'),
        this.all('feed').catch(() => []),
        this.all('funds').catch(() => []),
        this.all('fds').catch(() => []),
        this.all('dividends').catch(() => []),
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
      };
    },
    // Replace all data with the contents of a previously exported object.
    async importAll(data) {
      if (!data || data.app !== 'mynote-stocks') {
        throw new Error('This file is not a MyNote Stocks backup.');
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
      await Promise.all(tasks);
    },
  };
})();
