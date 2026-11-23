import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaderboardService } from '../lib/leaderboard-service.js';

function setup() {
  let time = 1_800_000_000_000;
  let revision = 0;
  const database = new Map();
  const store = {
    async read(path) { await Promise.resolve(); return structuredClone(database.get(path) ?? null); },
    async write(path, value, etag) {
      await Promise.resolve();
      const current = database.get(path);
      if (current ? current.etag !== etag : etag !== undefined) throw Object.assign(new Error('conflict'), { conflict: true });
      database.set(path, { value: structuredClone(value), etag: String(++revision) });
    }
  };
  const factory = () => createLeaderboardService({ store, now: () => time, sleep: async () => {}, log: () => {} });
  const handle = factory();
  const request = async (body, cookie = '', service = handle, headers = {}) => {
    const response = await service(new Request('https://stairs.example/api/leaderboard', {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    }));
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const start = async (cookie = '', service = handle) => {
    const result = await request({ action: 'start' }, cookie, service);
    assert.equal(result.status, 200);
    return { token: result.body.runToken, cookie: result.headers.get('set-cookie').split(';')[0] };
  };
  const submit = (round, steps, nickname = '계단왕', coins = Math.floor(steps / 5), service = handle) =>
    request({ action: 'submit', nickname, steps, coins, runToken: round.token }, round.cookie, service);
  return { handle, factory, request, start, submit, store, database, advance: ms => { time += ms; } };
}

test('empty public board is real empty data with no-store headers', async () => {
  const s = setup(), result = await s.request();
  assert.equal(result.status, 200); assert.deepEqual(result.body.entries, []);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('two independent clients and fresh server instances read the same durable ranks', async () => {
  const s = setup(), a = await s.start(), b = await s.start('', s.factory());
  s.advance(20000);
  assert.equal((await s.submit(a, 40, '도전자하나')).status, 200);
  assert.equal((await s.submit(b, 55, '도전자둘', 11, s.factory())).status, 200);
  const first = await s.request(undefined, a.cookie), second = await s.request(undefined, b.cookie, s.factory());
  assert.deepEqual(first.body, second.body);
  assert.deepEqual(first.body.entries.map(e => [e.nickname, e.steps]), [['도전자둘', 55], ['도전자하나', 40]]);
});
test('only highest score per signed participant is retained', async () => {
  const s = setup(), a = await s.start(); s.advance(10000);
  await s.submit(a, 80);
  const b = await s.start(a.cookie); s.advance(3000);
  const lower = await s.submit(b, 20);
  assert.equal(lower.body.improved, false); assert.equal(lower.body.bestSteps, 80);
  assert.equal((await s.request()).body.entries.length, 1);
  const c = await s.start(a.cookie); s.advance(3000);
  const higher = await s.submit(c, 100);
  assert.equal(higher.body.bestSteps, 100); assert.equal(higher.body.improved, true);
});
test('ties share the same competition rank', async () => {
  const s = setup(), rounds = await Promise.all([s.start(), s.start(), s.start()]); s.advance(10000);
  for (let i = 0; i < 3; i++) await s.submit(rounds[i], [30, 30, 20][i], `도전자${i}`);
  assert.deepEqual((await s.request()).body.entries.map(e => e.rank), [1, 1, 3]);
});
test('same nickname on separate clients does not overwrite another player', async () => {
  const s = setup(), a = await s.start(), b = await s.start(); s.advance(10000);
  await s.submit(a, 30, '같은별명'); await s.submit(b, 50, '같은별명');
  assert.equal((await s.request()).body.entries.length, 2);
});
test('concurrent first-time submissions preserve every record', async () => {
  const s = setup();
  const rounds = await Promise.all(Array.from({ length: 5 }, () => s.start('', s.factory())));
  s.advance(30000);
  const results = await Promise.all(rounds.map((r, i) => s.submit(r, 10 + i, `참가자${i}`, 0, s.factory())));
  assert(results.every(r => r.status === 200), JSON.stringify(results));
  assert.equal((await s.request()).body.total, 5);
});
test('duplicate response retries are idempotent; changed replay payload is rejected', async () => {
  const s = setup(), a = await s.start(); s.advance(10000);
  const first = await s.submit(a, 20), again = await s.submit(a, 20), altered = await s.submit(a, 25);
  assert.equal(first.status, 200); assert.equal(again.status, 200); assert.equal(altered.status, 409);
  assert.equal((await s.request()).body.entries.length, 1);
});
test('forged participant cookies and tampered round signatures are rejected', async () => {
  const s = setup(), a = await s.start(); s.advance(10000);
  assert.equal((await s.submit({ ...a, cookie: a.cookie + 'x' }, 10)).status, 400);
  assert.equal((await s.submit({ ...a, token: a.token + 'x' }, 10)).status, 400);
});
test('a round cannot be submitted from another participant', async () => {
  const s = setup(), a = await s.start(), b = await s.start(); s.advance(10000);
  assert.equal((await s.submit({ ...a, cookie: b.cookie }, 10)).status, 400);
});
test('invalid, impossible and expired scores are rejected', async () => {
  const s = setup(), a = await s.start();
  for (const [steps, coins] of [[0, 0], [-1, 0], [1.5, 0], [100001, 0], [5, 2], [10000, 0]]) {
    assert.equal((await s.submit(a, steps, '검증별명', coins)).status, 400);
  }
  s.advance(2 * 60 * 60 * 1000 + 1);
  assert.equal((await s.submit(a, 10)).status, 400);
});
test('cross-site requests, HTML nicknames and malformed payloads are rejected', async () => {
  const s = setup(), a = await s.start(); s.advance(10000);
  assert.equal((await s.request({ action: 'start' }, '', s.handle, { Origin: 'https://other.example' })).status, 403);
  for (const nickname of ['a', '<script>hi', 'a'.repeat(13), '   ']) assert.equal((await s.submit(a, 10, nickname)).status, 400);
  assert.equal((await s.request(null)).status, 400);
  assert.equal((await s.request({ action: 'submit', nickname: 'a'.repeat(5000) })).status, 413);
});
test('public API never exposes signing keys, player identifiers, receipts or cookies', async () => {
  const s = setup(), a = await s.start(); s.advance(10000); await s.submit(a, 10);
  const data = JSON.stringify((await s.request()).body);
  for (const key of ['playerId', 'recentRuns', 'runToken', 'expiresAt', 'lastSubmittedAt']) assert(!data.includes(key));
  assert.equal((await s.request()).headers.get('set-cookie'), null);
});
test('storage failure is shown as 503 and never disguised as an empty board', async () => {
  const handler = createLeaderboardService({ store: { read: async () => { throw Error('offline'); } }, log: () => {} });
  const response = await handler(new Request('https://stairs.example/api/leaderboard'));
  assert.equal(response.status, 503); assert.match((await response.json()).error, /연결/);
});
test('corrupt stored data is not overwritten or silently reset', async () => {
  const s = setup(); s.database.set('stairs/v1/leaderboard.json', { etag: 'corrupt', value: { version: 99 } });
  assert.equal((await s.request()).status, 503);
  assert.equal(s.database.get('stairs/v1/leaderboard.json').etag, 'corrupt');
});
test('server-created cookie has Secure, HttpOnly and SameSite protections', async () => {
  const s = setup(), result = await s.request({ action: 'start' });
  const cookie = result.headers.get('set-cookie');
  for (const part of ['__Host-stairs-player=', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert(cookie.includes(part));
});
