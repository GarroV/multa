import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { App } from './App.tsx';

// MVP: единый root, экраны выбираются по состоянию сессии (App). Реальные маршруты — Спринт 2.
const rootRoute = createRootRoute({ component: App });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null });

const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
