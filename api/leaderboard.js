import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { createLeaderboardService } from '../lib/leaderboard-service.js';

const prefix = process.env.VERCEL_ENV === 'production' ? 'production/' : 'preview/';
const handle = createLeaderboardService({
  store: {
    async read(path) {
      const response = await get(prefix + path, { access: 'private', useCache: false });
      if (!response) return null;
      if (response.statusCode !== 200) throw new Error('Unexpected blob read status');
      return { value: await new Response(response.stream).json(), etag: response.blob.etag };
    },
    async write(path, value, etag) {
      try {
        return await put(prefix + path, JSON.stringify(value), {
          access: 'private', contentType: 'application/json',
          addRandomSuffix: false, allowOverwrite: Boolean(etag),
          ...(etag ? { ifMatch: etag } : {})
        });
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError || /already exists|already_exists/i.test(error.message)) error.conflict = true;
        throw error;
      }
    }
  }
});

export function GET(request) { return handle(request); }
export function POST(request) { return handle(request); }
