import type { Queryable } from '../config/db';
import type { OrderKind } from '../config/r2';
import type { Acceso } from '../lib/permisos';

// El dueño del proyecto o un miembro activo de su equipo (permisos_en_proyecto,
// en comercyo-back-company-projects). acceso trae sus permisos por módulo.
// El pedido y su proyecto deben estar vivos (sin borrar).
const accessSql = (table: 'purchase_orders' | 'sales_orders' | 'trabajador_pagos', alias: 'po' | 'so' | 'tp', idColumn: string) => `
  SELECT ${alias}.id_own_project, permisos_en_proyecto(${alias}.id_own_project, $2::bigint) AS acceso
    FROM ${table} ${alias}
    JOIN own_projects op
      ON op.id_own_project = ${alias}.id_own_project
     AND op.deleted_at IS NULL
   WHERE ${alias}.${idColumn} = $1::bigint
     AND ${alias}.deleted_at IS NULL
     AND permisos_en_proyecto(${alias}.id_own_project, $2::bigint) IS NOT NULL
   LIMIT 1`;

export const ORDER_ACCESS_SQL = accessSql('purchase_orders', 'po', 'id_purchase_order');

// Abonos de la factura de venta: mismo control sobre el pedido de venta.
export const SALES_ORDER_ACCESS_SQL = accessSql('sales_orders', 'so', 'id_sales_order');

// Pagos a trabajadores (comercyo-back-services): el pago y su tienda.
export const WORKER_PAYMENT_ACCESS_SQL = accessSql('trabajador_pagos', 'tp', 'id_pago');

// Pagos recibidos de las facturas de obra (comercyo-back-services): el pago,
// su factura y la tienda. Los pagos anulados no se pueden ver ni tocar.
export const OBRA_PAYMENT_ACCESS_SQL = `
  SELECT f.id_own_project, permisos_en_proyecto(f.id_own_project, $2::bigint) AS acceso
    FROM obra_factura_pagos p
    JOIN obra_facturas f ON f.id_factura = p.id_factura
    JOIN own_projects op ON op.id_own_project = f.id_own_project AND op.deleted_at IS NULL
   WHERE p.id_pago = $1::bigint
     AND permisos_en_proyecto(f.id_own_project, $2::bigint) IS NOT NULL
   LIMIT 1`;

const SQL_BY_KIND: Record<OrderKind, string> = {
  purchase: ORDER_ACCESS_SQL,
  sales: SALES_ORDER_ACCESS_SQL,
  worker: WORKER_PAYMENT_ACCESS_SQL,
  obra: OBRA_PAYMENT_ACCESS_SQL,
};

export type AccesoPedido = { id_own_project: number; acceso: Acceso };

// El proyecto del pedido y el acceso del usuario, o null si no puede verlo.
export const findAccessibleOrderProject = async (
  db: Queryable,
  orderId: string,
  idUser: number,
  kind: OrderKind = 'purchase'
): Promise<AccesoPedido | null> => {
  const result = await db.query(SQL_BY_KIND[kind], [orderId, idUser]);
  const row = result.rows[0];
  return row?.acceso ? { id_own_project: Number(row.id_own_project), acceso: row.acceso } : null;
};
