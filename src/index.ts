import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app';
import { config } from './config/config';

// For local development with @hono/node-server
if (process.env.NODE_ENV !== 'production') {
  serve({
    fetch: app.fetch,
    port: config.port,
  });
}

// For Vercel (@vercel/node expects CommonJS export)
// This will be used when deployed to Vercel
export default app;

