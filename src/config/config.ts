import { origenesPermitidos } from './cors';

const corsOrigins = origenesPermitidos();

export const config = {
  port: Number(process.env.PORT || 3001),
  env: process.env.NODE_ENV || 'development',
  productionUrl: process.env.PRODUCTION_URL || 'https://hbsb-limpio.vercel.app',
  cors: {
    // Hono's cors() treats a string '*' as "allow any origin", but treats an
    // array as an explicit allow-list matched against the request's Origin
    // header - an array containing the literal string '*' never matches a
    // real origin. Collapse to the string form so a wildcard actually works.
    origin: corsOrigins,
  }
} as const;
