import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { App } from './App.tsx';
import { Exchange } from './screens/Exchange.tsx';
import { Obligations } from './screens/Obligations.tsx';
import { Plan } from './screens/Plan.tsx';
import { Settings } from './screens/Settings.tsx';
import { Today } from './screens/Today.tsx';

const rootRoute = createRootRoute({ component: App });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/today' });
  },
});

const todayRoute = createRoute({ getParentRoute: () => rootRoute, path: '/today', component: Today });
const planRoute = createRoute({ getParentRoute: () => rootRoute, path: '/plan', component: Plan });
const exchangeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/exchange', component: Exchange });
const obligationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/obligations', component: Obligations });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: Settings });

const routeTree = rootRoute.addChildren([
  indexRoute,
  todayRoute,
  planRoute,
  exchangeRoute,
  obligationsRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
