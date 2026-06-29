// IndexedDB data layer. All data lives on this device only.
export const DB = (function () {
  const NAME = 'mynote-stocks';
  const VERSION = 3;
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
      const [stocks, snapshots, monthly, meta, feed] = await Promise.all([
        this.all('stocks'),
        this.all('snapshots'),
        this.all('monthly'),
        this.all('meta'),
        this.all('feed').catch(() => []),
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
      ]);
      const tasks = [];
      (data.stocks || []).forEach((s) => tasks.push(this.put('stocks', s)));
      (data.snapshots || []).forEach((s) => tasks.push(this.put('snapshots', s)));
      (data.monthly || []).forEach((m) => tasks.push(this.put('monthly', m)));
      (data.meta || []).forEach((m) => tasks.push(this.put('meta', m)));
      // feed may be missing on older backups — silently skip.
      (data.feed || []).forEach((f) => tasks.push(this.put('feed', f).catch(() => {})));
      await Promise.all(tasks);
    },
  };
})();
