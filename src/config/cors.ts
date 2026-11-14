// Orígenes que pueden llamar a este backend desde el navegador.
//
// Nunca '*': si CORS_ORIGIN falta o trae '*', quedan solo los de Comercyo.
// CORS_ORIGIN (separado por comas) suma orígenes extra. localhost solo fuera
// de producción, para el front en desarrollo (vite dev / preview).
//
// En producción el front llama a casi todos los backends por las
// reescrituras /api/* de comercyo.com (mismo origen), así que esto solo
// frena a otras páginas web que intenten llamar al backend desde el
// navegador de un usuario. No frena bots ni scripts: para eso están los
// límites de solicitudes.
export const ORIGENES_COMERCYO = ['https://comercyo.com', 'https://www.comercyo.com'] as const;
export const ORIGENES_DESARROLLO = ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173'] as const;

export const origenesPermitidos = (env: Record<string, string | undefined> = process.env): string[] => {
  const extra = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o && o !== '*');
  const desarrollo = env.NODE_ENV === 'production' ? [] : ORIGENES_DESARROLLO;
  return [...new Set([...ORIGENES_COMERCYO, ...desarrollo, ...extra])];
};
