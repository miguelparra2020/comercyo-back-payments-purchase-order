import type { Queryable } from '../config/db';
import type { OrderKind } from '../config/r2';

// "Belonging to a project" today means owning it: own_projects has no
// members table, only created_by_email (see comercyo-back-company-projects).
// The order, its project and the user must all be live (not soft-deleted).
const accessSql = (table: 'purchase_orders' | 'sales_orders', alias: 'po' | 'so', idColumn: string) => `
  SELECT ${alias}.id_own_project
    FROM ${table} ${alias}
    JOIN own_projects op
      ON op.id_own_project = ${alias}.id_own_project
     AND op.deleted_at IS NULL
    JOIN users u
      ON u.email = op.created_by_email
     AND u.deleted_at IS NULL
   WHERE ${alias}.${idColumn} = $1::bigint
     AND ${alias}.deleted_at IS NULL
     AND u.id_user = $2
   LIMIT 1`;

export const ORDER_ACCESS_SQL = accessSql('purchase_orders', 'po', 'id_purchase_order');

// Abonos de la factura de venta: mismo control sobre el pedido de venta.
export const SALES_ORDER_ACCESS_SQL = accessSql('sales_orders', 'so', 'id_sales_order');

const SQL_BY_KIND: Record<OrderKind, string> = {
  purchase: ORDER_ACCESS_SQL,
  sales: SALES_ORDER_ACCESS_SQL,
};

// Returns the order's id_own_project when the user may access it, else null.
export const findAccessibleOrderProject = async (
  db: Queryable,
  orderId: string,
  idUser: number,
  kind: OrderKind = 'purchase'
): Promise<number | null> => {
  const result = await db.query(SQL_BY_KIND[kind], [orderId, idUser]);
  const row = result.rows[0];
  return row ? Number(row.id_own_project) : null;
};
