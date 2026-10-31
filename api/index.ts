import 'dotenv/config';
import app from '../src/app';

// Export the Hono app directly for Vercel
// Vercel's Edge Runtime can handle Hono apps natively
export default app;
