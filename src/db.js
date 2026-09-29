const DB_NAME = "pasteshot";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("tiles")) {
        const tiles = db.createObjectStore("tiles", { keyPath: ["sessionId", "index"] });
        tiles.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("aborted"));
  });
}

export async function putSession(session) {
  const db = await openDb();
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").put(session);
  await transactionDone(tx);
  db.close();
  return session;
}

export async function getSession(id) {
  const db = await openDb();
  const tx = db.transaction("sessions", "readonly");
  const session = await requestDone(tx.objectStore("sessions").get(id));
  await transactionDone(tx);
  db.close();
  return session ?? null;
}

export async function updateSession(id, patch) {
  const current = await getSession(id);
  if (!current) return null;
  return putSession({ ...current, ...patch, id });
}

export async function putTile(tile) {
  const db = await openDb();
  const tx = db.transaction("tiles", "readwrite");
  tx.objectStore("tiles").put(tile);
  await transactionDone(tx);
  db.close();
}

export async function tilesFor(sessionId) {
  const db = await openDb();
  const tx = db.transaction("tiles", "readonly");
  const tiles = await requestDone(tx.objectStore("tiles").index("sessionId").getAll(sessionId));
  await transactionDone(tx);
  db.close();
  return tiles.sort((a, b) => a.index - b.index);
}

export async function deleteTiles(sessionId) {
  const tiles = await tilesFor(sessionId);
  if (tiles.length === 0) return;
  const db = await openDb();
  const tx = db.transaction("tiles", "readwrite");
  const store = tx.objectStore("tiles");
  for (const tile of tiles) store.delete([tile.sessionId, tile.index]);
  await transactionDone(tx);
  db.close();
}

export async function pruneSessions(keep = 4) {
  const db = await openDb();
  const tx = db.transaction("sessions", "readonly");
  const sessions = await requestDone(tx.objectStore("sessions").getAll());
  await transactionDone(tx);
  db.close();
  const extra = sessions.sort((a, b) => b.createdAt - a.createdAt).slice(keep);
  for (const session of extra) {
    await deleteTiles(session.id);
    const next = await openDb();
    const write = next.transaction("sessions", "readwrite");
    write.objectStore("sessions").delete(session.id);
    await transactionDone(write);
    next.close();
  }
}
