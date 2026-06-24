import { handleScan } from './routes/ai.js';
import { handleFx } from './routes/fx.js';
import { handleKvLoad, handleKvSave } from './routes/kv.js';
import { corsHeaders, json, withCors } from './services/http.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname === '/api/scan' && request.method === 'POST') {
        return withCors(await handleScan(request, env));
      }

      if (url.pathname === '/kv/load' && request.method === 'GET') {
        return withCors(await handleKvLoad(env));
      }

      if (url.pathname === '/kv/save' && request.method === 'POST') {
        return withCors(await handleKvSave(request, env));
      }

      if (url.pathname.startsWith('/fx/')) {
        return withCors(await handleFx(url));
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json(
        {
          error: {
            message: error.message || 'Error inesperado',
            code: error.code || 'internal_error'
          }
        },
        500
      );
    }
  }
};
