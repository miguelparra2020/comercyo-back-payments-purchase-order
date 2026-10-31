import { Pool } from 'pg';
import { requiredEnv } from '../utils/env.utils';

// Same connection scheme as comercyo-back-create-purchase-order (src/config/db.ts):
// postgresql://postgres.<ref>:<password>@aws-xxx.pooler.supabase.com:6543/postgres
// users, own_projects and purchase_orders all live in this database.
let pool: Pool | undefined;

export type Queryable = Pick<Pool, 'query'>;

export const getUsersDb = (): Queryable => {
  if (pool) {
    return pool;
  }

  const connectionString =
    `${requiredEnv('DATABASE_BASE')}${requiredEnv('TIENDAS_DB_REF')}:` +
    `${requiredEnv('DATABASE_PASSWORD')}${requiredEnv('DATABASE_HOST')}`;

  pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  return pool;
};
