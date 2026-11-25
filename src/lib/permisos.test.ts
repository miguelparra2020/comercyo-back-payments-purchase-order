import { describe, it, expect } from 'vitest';
import { accionDe, mensajeSinPermiso, permisoFaltante, puede, type Acceso, type Regla } from './permisos';

const miembro = (permisos: Record<string, string[]>): Acceso => ({ duenio: false, rol: 'Vendedor', permisos });

const REGLAS: Regla[] = [
  { ruta: /\/ventas\/rapida/, modulo: 'caja_rapida' },
  { ruta: /\/ventas/, metodos: ['GET'], modulo: ['pedidos_venta', 'caja_rapida'] },
  { ruta: /\/ventas\/\d+\/entregar/, modulo: 'rutas_entrega', accion: 'editar' },
  { ruta: /\/ventas/, modulo: 'pedidos_venta' },
];

describe('permisos (lib compartida)', () => {
  it('la acción sale del método; anular y cancelar son borrar', () => {
    expect(accionDe('GET', '/x')).toBe('ver');
    expect(accionDe('post', '/x')).toBe('crear');
    expect(accionDe('PUT', '/x/1')).toBe('editar');
    expect(accionDe('PATCH', '/x/1')).toBe('editar');
    expect(accionDe('DELETE', '/x/1')).toBe('borrar');
    expect(accionDe('POST', '/x/1/cancel')).toBe('borrar');
    expect(accionDe('POST', '/x/1/pagos/2/void')).toBe('borrar');
  });

  it('el dueño puede todo, incluso lo que no tiene regla', () => {
    expect(permisoFaltante({ duenio: true }, REGLAS, 'DELETE', '/otra-cosa')).toBeNull();
  });

  it('crear, editar o borrar implican ver', () => {
    expect(puede(miembro({ clientes: ['crear'] }), 'clientes', 'ver')).toBe(true);
    expect(puede(miembro({ clientes: ['ver'] }), 'clientes', 'crear')).toBe(false);
    expect(puede(miembro({}), 'clientes', 'ver')).toBe(false);
  });

  it('una ruta sin regla es solo del dueño', () => {
    expect(permisoFaltante(miembro({ clientes: ['ver'] }), REGLAS, 'GET', '/ajustes')).toEqual({ modulo: 'duenio', accion: 'ver' });
  });

  it('la primera regla que coincide gana, con método y varias claves', () => {
    const cajero = miembro({ caja_rapida: ['ver', 'crear'] });
    expect(permisoFaltante(cajero, REGLAS, 'POST', '/api/v1/ventas/rapida')).toBeNull();
    expect(permisoFaltante(cajero, REGLAS, 'GET', '/api/v1/ventas')).toBeNull();
    expect(permisoFaltante(cajero, REGLAS, 'POST', '/api/v1/ventas')).toEqual({ modulo: 'pedidos_venta', accion: 'crear' });

    const domiciliario = miembro({ rutas_entrega: ['ver', 'editar'] });
    expect(permisoFaltante(domiciliario, REGLAS, 'POST', '/api/v1/ventas/12/entregar')).toBeNull();
    expect(permisoFaltante(domiciliario, REGLAS, 'POST', '/api/v1/ventas/12/cancel')).toEqual({ modulo: 'pedidos_venta', accion: 'borrar' });
  });

  it('mensajes en español', () => {
    expect(mensajeSinPermiso({ modulo: 'duenio', accion: 'ver' })).toBe('Solo el dueño de la tienda puede hacer esto');
    expect(mensajeSinPermiso({ modulo: 'clientes', accion: 'borrar' })).toContain('borrar o anular en clientes');
  });
});
