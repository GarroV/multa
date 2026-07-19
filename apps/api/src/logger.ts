/* eslint-disable no-console -- централизованный логгер; console только здесь */

export const logger = {
  info: (...args: unknown[]): void => console.info('[api]', ...args),
  warn: (...args: unknown[]): void => console.warn('[api]', ...args),
  error: (message: string, err?: unknown): void => console.error('[api]', message, err ?? ''),
};
