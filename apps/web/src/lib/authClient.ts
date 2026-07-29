import { createAuthClient } from 'better-auth/react';
import { API_ORIGIN } from './apiUrl.ts';
import { authClientOptions } from './authClientOptions.ts';

/** Клиент better-auth. Резолв baseURL/basePath — в authClientOptions (там же почему). */
export const authClient = createAuthClient(authClientOptions(API_ORIGIN));
