import { createAuthClient } from 'better-auth/react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/** Клиент better-auth. baseURL включает кастомный basePath /v1/auth. */
export const authClient = createAuthClient({
  baseURL: `${API_URL}/v1/auth`,
  fetchOptions: { credentials: 'include' },
});
