// Permisos del equipo de una tienda (proyecto). La regla vive en la base:
// permisos_en_proyecto(id_own_project, id_user) devuelve {"duenio": true} para el
// dueño, {"duenio": false, "rol", "permisos": {"clientes": ["ver", ...]}} para un
// miembro activo del equipo, o NULL si no tiene acceso. Este archivo es igual en
// todos los backends con requireOwnProject; cada uno define sus REGLAS.

export type Accion = 'ver' | 'crear' | 'editar' | 'borrar';

export type Acceso = { duenio: boolean; id_miembro?: string | number; rol?: string | null; permisos?: Record<string, string[]> };

export const ACCESO_SQL = `SELECT permisos_en_proyecto($1::bigint, $2::bigint) AS acceso`;

/** Módulo especial: solo el dueño de la tienda. */
export const SOLO_DUENIO = 'duenio';

/**
 * Qué permiso pide una ruta. La primera regla que coincide gana; una ruta sin
 * regla es solo del dueño. `modulo` con varias claves: basta con una de ellas.
 * `accion` fija la acción; si no, sale del método (GET ver, POST crear,
 * PUT/PATCH editar, DELETE borrar; anular o cancelar es borrar).
 */
export type Regla = { ruta: RegExp; modulo: string | readonly string[]; metodos?: readonly string[]; accion?: Accion };

const POR_METODO: Record<string, Accion> = { GET: 'ver', HEAD: 'ver', POST: 'crear', PUT: 'editar', PATCH: 'editar', DELETE: 'borrar' };

export function accionDe(metodo: string, ruta: string): Accion {
  if (/\/(cancel|void|anular|withdraw)\/?$/.test(ruta)) return 'borrar';
  return POR_METODO[metodo.toUpperCase()] ?? 'editar';
}

/** Crear, editar o borrar en un módulo implican ver. */
export function puede(acceso: Acceso, modulo: string, accion: Accion): boolean {
  if (acceso.duenio) return true;
  if (modulo === SOLO_DUENIO) return false;
  const lista = acceso.permisos?.[modulo] ?? [];
  return lista.includes(accion) || (accion === 'ver' && lista.length > 0);
}

export type Faltante = { modulo: string; accion: Accion };

export function permisoFaltante(acceso: Acceso, reglas: readonly Regla[], metodo: string, ruta: string): Faltante | null {
  if (acceso.duenio) return null;
  const m = metodo.toUpperCase();
  const regla = reglas.find((r) => r.ruta.test(ruta) && (!r.metodos || r.metodos.includes(m)));
  const modulos = regla ? (typeof regla.modulo === 'string' ? [regla.modulo] : regla.modulo) : [SOLO_DUENIO];
  const accion = regla?.accion ?? accionDe(m, ruta);
  return modulos.some((mod) => puede(acceso, mod, accion)) ? null : { modulo: modulos[0], accion };
}

const VERBO: Record<Accion, string> = { ver: 'ver', crear: 'crear', editar: 'editar', borrar: 'borrar o anular' };

const NOMBRE: Record<string, string> = {
  asistente: 'el asistente',
  inventario: 'el inventario',
  servicios: 'servicios y citas',
  clientes: 'clientes',
  caja_rapida: 'la caja rápida',
  pedidos_venta: 'pedidos de venta',
  rutas_entrega: 'rutas de entrega',
  medios_pago_ventas: 'medios de pago',
  ingresos_adicionales: 'ingresos adicionales',
  proveedores: 'proveedores',
  pedidos_compra: 'pedidos de compra',
  gastos_adicionales: 'gastos adicionales',
  estado_tienda: 'el estado de la tienda',
  info_tienda: 'la información de la tienda',
  carritos: 'carritos',
  mensajes: 'mensajes',
  domicilios: 'domicilios',
  historias: 'historias',
  visitas: 'visitas',
  minar: 'Minar',
};

export function mensajeSinPermiso({ modulo, accion }: Faltante): string {
  if (modulo === SOLO_DUENIO) return 'Solo el dueño de la tienda puede hacer esto';
  return `No tienes permiso para ${VERBO[accion]} en ${NOMBRE[modulo] ?? modulo}. Pídeselo al dueño de la tienda.`;
}
