import { get } from '@vercel/blob';
import { createLeaderboardService } from '../lib/leaderboard-service.js';
import { createFirestoreStore } from '../lib/firestore-store.js';
import { getLeaderboardDatabase } from '../lib/firebase-admin.js';

const scope = process.env.VERCEL_ENV === 'production' ? 'production' : 'preview';
const handle = createLeaderboardService({ store: createFirestoreStore({
  getDb: getLeaderboardDatabase,
  scope,
  legacyStore: {
    async read(path) {
      if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) return null;
      const response = await get(`${scope}/${path}`, { access: 'private', useCache: false });
      if (!response) return null;
      if (response.statusCode !== 200) throw new Error('Unexpected blob read status');
      return { value: await new Response(response.stream).json(), etag: response.blob.etag };
    }
  }
}) });

export function GET(request) { return handle(request); }
export function POST(request) { return handle(request); }
