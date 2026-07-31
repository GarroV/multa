import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { App } from './App.tsx';
import { Demo } from './screens/Demo.tsx';
import { Exchange } from './screens/Exchange.tsx';
import { Obligations } from './screens/Obligations.tsx';
import { Plan } from './screens/Plan.tsx';
import { Settings } from './screens/Settings.tsx';

const rootRoute = createRootRoute({ component: App });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/plan' });
  },
});

// «Сегодня» слился с планом (issue #30): один плотный экран вместо обзора и деталей по отдельности.
const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/today',
  beforeLoad: () => {
    throw redirect({ to: '/plan' });
  },
});
const planRoute = createRoute({ getParentRoute: () => rootRoute, path: '/plan', component: Plan });
const exchangeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/exchange', component: Exchange });
const obligationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/obligations', component: Obligations });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: Settings });
// Демо без регистрации (#56): единственный экран, который не требует сессии — он её и получает.
const demoRoute = createRoute({ getParentRoute: () => rootRoute, path: '/demo', component: Demo });

const routeTree = rootRoute.addChildren([
  indexRoute,
  todayRoute,
  planRoute,
  exchangeRoute,
  obligationsRoute,
  settingsRoute,
  demoRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
