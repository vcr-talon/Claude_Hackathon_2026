// 開いたデータファイルを、この端末の中（IndexedDB）に1件だけ残す。
// iPad ではダウンロードしたファイルの場所が分かりにくく、Safari が裏のタブを閉じるたびに探し直すのは手間なため。
// localStorage は容量が小さい（データは1件 200KB 前後）ので、ファイル本体はこちらに置く。どこにも送信しない。
const DB = 'site-app';
const STORE = 'data';
const KEY = 'last';

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('この端末ではデータを残せません'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// text：データファイルの中身そのまま。info：最初の画面に出す見出し（title・exported_at）
export const saveData = (text, info) => run('readwrite', (s) => s.put({ text, ...info, saved: new Date().toISOString() }, KEY));
export const loadData = () => run('readonly', (s) => s.get(KEY));
export const clearData = () => run('readwrite', (s) => s.delete(KEY));
