import type { Queryable } from '../config/db';

// "Belonging to a project" today means owning it: own_projects has no
// members table, only created_by_email (see comercyo-back-company-projects).
// The order, its project and the user must all be live (not soft-deleted).
export const ORDER_ACCESS_SQL = `
  SELECT po.id_own_project
    FROM purchase_orders po
    JOIN own_projects op
      ON op.id_own_project = po.id_own_project
     AND op.deleted_at IS NULL
    JOIN users u
      ON u.email = op.created_by_email
     AND u.deleted_at IS NULL
   WHERE po.id_purchase_order = $1::bigint
     AND po.deleted_at IS NULL
     AND u.id_user = $2
   LIMIT 1`;

// Returns the order's id_own_project when the user may access it, else null.
export const findAccessibleOrderProject = async (
  db: Queryable,
  orderId: string,
  idUser: number
): Promise<number | null> => {
  const result = await db.query(ORDER_ACCESS_SQL, [orderId, idUser]);
  const row = result.rows[0];
  return row ? Number(row.id_own_project) : null;
};
