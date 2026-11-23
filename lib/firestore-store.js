// Server-side Firestore document adapter. No Firebase credential is sent to the browser.
export function createFirestoreStore({ getDb, scope, legacyStore = null }) {
  function document(path) {
    const name = path.endsWith('/server-key.json') ? 'server-key' : path.endsWith('/leaderboard.json') ? 'leaderboard' : null;
    if (!name) throw new Error('Unknown leaderboard document');
    return getDb().collection('stairsLeaderboard').doc(`${scope}_${name}`);
  }
  function conflict(error) { return [5, 6, 9, 10].includes(error.code); }
  return {
    async read(path) {
      const ref = document(path);
      let snapshot = await ref.get();
      if (!snapshot.exists && legacyStore) {
        // Copy legacy records and the signing key once. Firebase errors never fall
        // back to writing Blob, so successful registrations always live in Firestore.
        const old = await legacyStore.read(path);
        if (old) {
          try { await ref.create({ value: old.value, migratedAt: new Date(), migratedFrom: 'Vercel Blob' }); }
          catch (error) { if (!conflict(error)) throw error; }
          snapshot = await ref.get();
          if (!snapshot.exists) throw new Error('Firestore migration could not be verified');
        }
      }
      return snapshot.exists ? { value: snapshot.data().value, etag: snapshot.updateTime } : null;
    },
    async write(path, value, etag) {
      if (Buffer.byteLength(JSON.stringify(value)) > 850000) throw new Error('Leaderboard document capacity reached');
      const ref = document(path);
      try {
        if (etag) return await ref.update({ value, updatedAt: new Date() }, { lastUpdateTime: etag });
        return await ref.create({ value, updatedAt: new Date() });
      } catch (error) {
        if (conflict(error)) error.conflict = true;
        throw error;
      }
    }
  };
}
