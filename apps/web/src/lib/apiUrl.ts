/**
 * Origin API. Пусто в прод-сборке (фронт и api за одним Caddy, см. Caddyfile.prod) —
 * тогда запросы идут относительными путями от origin страницы. В деве Vite и api живут
 * на разных портах, поэтому VITE_API_URL задаёт абсолютный origin.
 */
export const API_ORIGIN: string = (import.meta.env.VITE_API_URL ?? '').trim();
