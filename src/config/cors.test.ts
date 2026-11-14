import { describe, expect, it } from 'vitest';
import { origenesPermitidos } from './cors';

const COMERCYO = ['https://comercyo.com', 'https://www.comercyo.com'];

describe('origenesPermitidos', () => {
  it('nunca acepta *: sin CORS_ORIGIN o con * quedan solo los de Comercyo', () => {
    expect(origenesPermitidos({ NODE_ENV: 'production' })).toEqual(COMERCYO);
    expect(origenesPermitidos({ NODE_ENV: 'production', CORS_ORIGIN: '*' })).toEqual(COMERCYO);
    expect(origenesPermitidos({ NODE_ENV: 'production', CORS_ORIGIN: ' * , ' })).toEqual(COMERCYO);
  });

  it('suma los de CORS_ORIGIN sin repetir', () => {
    expect(origenesPermitidos({ NODE_ENV: 'production', CORS_ORIGIN: 'https://comercyo.com, https://staging.comercyo.com' })).toEqual([
      ...COMERCYO,
      'https://staging.comercyo.com',
    ]);
  });

  it('localhost solo fuera de producción', () => {
    expect(origenesPermitidos({ NODE_ENV: 'production' })).not.toContain('http://localhost:5173');
    expect(origenesPermitidos({ NODE_ENV: 'development' })).toContain('http://localhost:5173');
    expect(origenesPermitidos({})).toContain('http://localhost:5173');
  });
});
