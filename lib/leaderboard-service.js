import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const BOARD_PATH = 'stairs/v1/leaderboard.json';
const KEY_PATH = 'stairs/v1/server-key.json';
const COOKIE = '__Host-stairs-player';
const MAX_ENTRIES = 1000;
const TOP_COUNT = 50;
const MAX_STEPS = 100000;
const ROUND_LIFETIME = 2 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function mac(data, key) { return createHmac('sha256', key).update(data).digest('base64url'); }
function sign(payload, key) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${mac(data, key)}`;
}
function verify(token, key) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const [data, signature, extra] = token.split('.');
  if (!data || !signature || extra) return null;
  const expected = Buffer.from(mac(data, key));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
}
function cookieValue(request) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return null;
}
function compare(a, b) { return b.steps - a.steps || a.achievedAt - b.achievedAt || a.playerId.localeCompare(b.playerId); }
function ranks(entries) {
  let rank = 0;
  return entries.map((entry, index) => {
    if (!index || entry.steps !== entries[index - 1].steps) rank = index + 1;
    return { ...entry, rank };
  });
}
function publicBoard(board) {
  return {
    entries: ranks(board.entries).slice(0, TOP_COUNT).map(({ rank, nickname, steps, coins, achievedAt }) =>
      ({ rank, nickname, steps, coins, achievedAt })),
    total: board.entries.length,
    updatedAt: board.updatedAt,
    limit: TOP_COUNT
  };
}
function validNickname(value) {
  if (typeof value !== 'string') throw new RequestError(400, '닉네임을 입력해 주세요.');
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if ([...name].length < 2 || [...name].length > 12 || !/^[\p{L}\p{N} _-]+$/u.test(name)) {
    throw new RequestError(400, '닉네임은 한글·영문·숫자·공백·밑줄·붙임표로 2~12자 입력해 주세요.');
  }
  return name;
}

// Store exposes read(path) -> {value, etag}|null and write(path, value, etag).
// No scores live in process memory; every merge reads the shared durable board.
export function createLeaderboardService({ store, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.error }) {
  let keyPromise;
  async function signingKey() {
    if (!keyPromise) keyPromise = (async () => {
      const saved = await store.read(KEY_PATH);
      if (saved?.value?.key) return saved.value.key;
      const key = randomBytes(32).toString('base64url');
      try { await store.write(KEY_PATH, { key }); return key; }
      catch (error) {
        if (!error.conflict) throw error;
        const winner = await store.read(KEY_PATH);
        if (!winner?.value?.key) throw error;
        return winner.value.key;
      }
    })().catch(error => { keyPromise = null; throw error; });
    return keyPromise;
  }
  async function readBoard() {
    const saved = await store.read(BOARD_PATH);
    if (!saved) return { value: { version: 1, entries: [], recentRuns: [], updatedAt: null }, etag: undefined };
    if (saved.value?.version !== 1 || !Array.isArray(saved.value.entries) || !Array.isArray(saved.value.recentRuns)) {
      throw new Error('Leaderboard data format invalid');
    }
    return saved;
  }
  function json(value, status = 200, extraHeaders = {}) {
    return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders } });
  }
  async function register(input, player, key) {
    const nickname = validNickname(input.nickname);
    const ticket = verify(input.runToken, key);
    const time = now();
    if (!ticket || ticket.kind !== 'round' || ticket.playerId !== player.id || !UUID.test(ticket.id) ||
      !Number.isSafeInteger(ticket.startedAt) || time < ticket.startedAt || time - ticket.startedAt > ROUND_LIFETIME) {
      throw new RequestError(400, '이번 게임의 등록 시간이 만료되었어요. 새 게임을 시작해 주세요.');
    }
    const { steps, coins } = input;
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_STEPS ||
      !Number.isSafeInteger(coins) || coins < 0 || coins > Math.floor(steps / 5) ||
      steps > Math.floor((time - ticket.startedAt + 1000) / 40)) {
      throw new RequestError(400, '등록할 점수를 확인해 주세요. 이번 게임의 1층 이상 기록만 등록할 수 있어요.');
    }
    for (let attempt = 0; attempt < 7; attempt++) {
      const saved = await readBoard();
      const board = saved.value;
      const previous = board.entries.find(entry => entry.playerId === player.id);
      const replay = board.recentRuns.find(run => run.id === ticket.id);
      if (replay && (replay.steps !== steps || replay.coins !== coins || replay.nickname !== nickname)) {
        throw new RequestError(409, '이미 등록한 게임이에요. 새 게임의 점수로 다시 도전해 주세요.');
      }
      if (!replay && previous && time - previous.lastSubmittedAt < 1500) {
        throw new RequestError(429, '잠시 후 다시 등록해 주세요.');
      }
      const improved = !previous || steps > previous.steps;
      const entry = improved ? { playerId: player.id, nickname, steps, coins, achievedAt: time, lastSubmittedAt: time }
        : { ...previous, lastSubmittedAt: time };
      const entries = board.entries.filter(item => item.playerId !== player.id).concat(entry).sort(compare).slice(0, MAX_ENTRIES);
      const rank = ranks(entries).find(item => item.playerId === player.id)?.rank ?? null;
      if (!replay) {
        const recentRuns = board.recentRuns.filter(run => time - run.at < ROUND_LIFETIME).concat({ id: ticket.id, at: time, steps, coins, nickname });
        // Keep replay receipts for the full ticket lifetime, never evict a valid receipt.
        if (recentRuns.length > 2000) throw new RequestError(503, '등록 요청이 많아요. 잠시 후 다시 시도해 주세요.');
        const next = { version: 1, entries, recentRuns, updatedAt: time };
        try {
          await store.write(BOARD_PATH, next, saved.etag);
          return { ...publicBoard(next), rank, bestSteps: entry.steps, improved, saved: true };
        } catch (error) {
          if (!error.conflict) throw error;
          if (attempt === 6) throw new RequestError(503, '다른 기록을 저장 중이에요. 잠시 후 다시 등록해 주세요.');
          await sleep(15 + Math.random() * 45);
        }
      } else {
        return { ...publicBoard(board), rank, bestSteps: previous?.steps ?? steps, improved: false, saved: true };
      }
    }
  }
  return async function handle(request) {
    try {
      if (request.method === 'GET') return json(publicBoard((await readBoard()).value));
      if (request.method !== 'POST') return json({ error: '지원하지 않는 요청입니다.' }, 405, { Allow: 'GET, POST' });
      const origin = request.headers.get('origin');
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
        throw new RequestError(403, '게임 페이지에서 등록해 주세요.');
      }
      if (!(request.headers.get('content-type') || '').startsWith('application/json')) throw new RequestError(415, 'JSON 요청이 필요합니다.');
      if (Number(request.headers.get('content-length')) > 4096) throw new RequestError(413, '요청이 너무 큽니다.');
      const text = await request.text();
      if (Buffer.byteLength(text) > 4096) throw new RequestError(413, '요청이 너무 큽니다.');
      let input;
      try { input = JSON.parse(text); } catch { throw new RequestError(400, '요청을 확인해 주세요.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, '요청을 확인해 주세요.');
      const key = await signingKey();
      let player = verify(cookieValue(request), key);
      const validPlayer = player?.kind === 'player' && UUID.test(player.id) && player.expiresAt > now();
      if (input.action === 'start') {
        if (!validPlayer) player = { kind: 'player', id: randomUUID(), expiresAt: now() + 365 * 24 * 60 * 60 * 1000 };
        const token = sign({ kind: 'round', id: randomUUID(), playerId: player.id, startedAt: now() }, key);
        return json({ runToken: token }, 200, { 'Set-Cookie': `${COOKIE}=${sign(player, key)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` });
      }
      if (input.action !== 'submit') throw new RequestError(400, '요청을 확인해 주세요.');
      if (!validPlayer) throw new RequestError(400, '게임 연결이 만료되었어요. 새 게임을 시작해 주세요.');
      return json(await register(input, player, key));
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.message }, error.status);
      log('Leaderboard storage request failed', { name: error.name });
      return json({ error: '공용 순위 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' }, 503);
    }
  };
}
