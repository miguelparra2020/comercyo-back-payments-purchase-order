import type { Regla } from '../lib/permisos';

// Qué permiso del equipo piden los comprobantes de pago (ver src/lib/permisos.ts).
// Subir el comprobante de un pago es parte de registrarlo: crear.
export const REGLAS_POR_TIPO = {
  purchase: [
    { ruta: /\/purchase-orders\//, metodos: ['GET', 'HEAD', 'DELETE'], modulo: 'pedidos_compra' },
    { ruta: /\/purchase-orders\//, modulo: 'pedidos_compra', accion: 'crear' },
  ],
  sales: [
    { ruta: /\/sales-orders\//, metodos: ['GET', 'HEAD', 'DELETE'], modulo: ['pedidos_venta', 'caja_rapida'] },
    { ruta: /\/sales-orders\//, modulo: ['pedidos_venta', 'caja_rapida'], accion: 'crear' },
  ],
  worker: [
    { ruta: /\/worker-payments\//, metodos: ['GET', 'HEAD', 'DELETE'], modulo: ['trabajadores', 'presupuestos'] },
    { ruta: /\/worker-payments\//, modulo: ['trabajadores', 'presupuestos'], accion: 'crear' },
  ],
} as const satisfies Record<string, readonly Regla[]>;
