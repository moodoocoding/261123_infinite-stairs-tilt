import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStore } from '../lib/firestore-store.js';
import { firebaseConnectionOptions } from '../lib/firebase-admin.js';

function fixture() {
  const records = new Map(); let revision = 0;
  const db = { collection(name) {
    assert.equal(name, 'stairsLeaderboard');
    return { doc(id) { return {
      async get() {
        const row = records.get(id);
        return { exists: Boolean(row), data: () => structuredClone(row.data), updateTime: row?.etag };
      },
      async create(data) {
        if (records.has(id)) throw Object.assign(new Error('exists'), { code: 6 });
        records.set(id, { data: structuredClone(data), etag: String(++revision) });
      },
      async update(data, precondition) {
        const row = records.get(id);
        if (!row || row.etag !== precondition.lastUpdateTime) throw Object.assign(new Error('precondition'), { code: 9 });
        records.set(id, { data: { ...row.data, ...structuredClone(data) }, etag: String(++revision) });
      }
    }; } };
  } };
  return { records, db, make: (scope = 'production', legacyStore = null) => createFirestoreStore({ getDb: () => db, scope, legacyStore }) };
}
const path = 'stairs/v1/leaderboard.json';
test('Firestore persists and returns data with its update-time precondition', async () => {
  const f = fixture(), store = f.make(); assert.equal(await store.read(path), null);
  await store.write(path, { entries: [1] });
  const before = await store.read(path); assert.deepEqual(before.value, { entries: [1] });
  await store.write(path, { entries: [2] }, before.etag);
  assert.deepEqual((await store.read(path)).value, { entries: [2] });
});
test('Firestore rejects stale writers without losing the winning update', async () => {
  const f = fixture(), store = f.make(); await store.write(path, { score: 1 });
  const before = await store.read(path); await store.write(path, { score: 2 }, before.etag);
  await assert.rejects(store.write(path, { score: 3 }, before.etag), error => error.conflict === true);
  assert.equal((await store.read(path)).value.score, 2);
});
test('legacy score and signing-key documents migrate once and are then read from Firebase', async () => {
  let reads = 0;
  const f = fixture(), store = f.make('production', { read: async () => { reads++; return { value: { key: 'preserved-or-score' } }; } });
  await store.read(path); await store.read(path);
  await store.read('stairs/v1/server-key.json'); await store.read('stairs/v1/server-key.json');
  assert.equal(reads, 2); assert.equal(f.records.size, 2);
  assert.equal((await store.read('stairs/v1/server-key.json')).value.key, 'preserved-or-score');
});
test('preview and production records stay isolated', async () => {
  const f = fixture(); await f.make('preview').write(path, { test: true });
  assert.equal(await f.make('production').read(path), null);
});
test('database errors do not silently fall back to a different write store', async () => {
  let legacyReads = 0;
  const store = createFirestoreStore({ scope: 'production', getDb: () => { throw Error('denied'); },
    legacyStore: { read: async () => { legacyReads++; } } });
  await assert.rejects(store.read(path), /denied/); assert.equal(legacyReads, 0);
});
test('unknown document paths and oversized documents are rejected', async () => {
  const f = fixture(); await assert.rejects(f.make().read('not-allowed'), /Unknown/);
  await assert.rejects(f.make().write(path, { data: 'x'.repeat(850001) }), /capacity/);
});
test('Firebase initialization rejects every different project and foreign service account', () => {
  assert.throws(() => firebaseConnectionOptions({ FIREBASE_PROJECT_ID: 'different-project' }), /must belong/);
  assert.throws(() => firebaseConnectionOptions({ GCP_PROJECT_NUMBER: '123', GCP_SERVICE_ACCOUNT_EMAIL: 'account@other-project.iam.gserviceaccount.com',
    GCP_WORKLOAD_IDENTITY_POOL_ID: 'vercel', GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: 'stairs' }), /not configured/);
});
test('keyless Firestore settings construct without reading or embedding a private key', () => {
  const options = firebaseConnectionOptions({ GCP_PROJECT_NUMBER: '123456789012',
    GCP_SERVICE_ACCOUNT_EMAIL: 'stairs-vercel@leadder-d2ca1.iam.gserviceaccount.com',
    GCP_WORKLOAD_IDENTITY_POOL_ID: 'vercel', GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: 'stairs' });
  assert.equal(options.projectId, 'leadder-d2ca1'); assert.equal(options.preferRest, true);
  assert(options.auth); assert.equal(options.credentials, undefined);
});
