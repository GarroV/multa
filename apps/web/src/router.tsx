import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { App } from './App.tsx';
import { ErrorScreen, reportError } from './components/ErrorBoundary.tsx';
import { Demo } from './screens/Demo.tsx';
import { History } from './screens/History.tsx';
import { Statistics } from './screens/Statistics.tsx';
import { Obligations } from './screens/Obligations.tsx';
import { Plan } from './screens/Plan.tsx';
import { Settings } from './screens/Settings.tsx';

const rootRoute = createRootRoute({ component: App });

/*
 * Корень больше не редиректит слепо (Спринт 6): у холодного посетителя должен быть лендинг, а не
 * форма регистрации. Кому именно что показать — решает гейт в App: он единственный знает, есть ли
 * сессия. Редирект остался бы гонкой с загрузкой `me`.
 */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => null,
});

/** Вход отдельным адресом: с лендинга на него ведут кнопки, и он должен быть ссылкой. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: () => null,
});

// «Сегодня» слился с планом (issue #30): один плотный экран вместо обзора и деталей по отдельности.
const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/today',
  beforeLoad: () => {
    throw redirect({ to: '/plan' });
  },
});
/**
 * Вид плана и предпросмотр живут в адресе, а не в состоянии экрана: оба переключателя переехали в
 * топбар (он вне экрана и до его состояния не дотянется), а заодно ссылка стала честной — «покажи,
 * как это выглядит таблицей» пересылается как ссылка, а не как инструкция куда нажать.
 */
const planRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plan',
  component: Plan,
  validateSearch: (search: Record<string, unknown>): { view?: 'table'; as?: 'member' } => ({
    ...(search.view === 'table' ? { view: 'table' as const } : {}),
    ...(search.as === 'member' ? { as: 'member' as const } : {}),
  }),
});
/**
 * История трат (issue #137). Отдельным адресом, а не вкладкой внутри статистики: «где та покупка»
 * — вопрос, с которым приходят напрямую, и на него нужна ссылка.
 */
const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: History,
});
const statisticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/statistics',
  component: Statistics,
});
// Размен переехал в «Статистику» (issue #30): ввод, копилка потерь и история стоят рядом с
// метриками, которые из них и считаются. Старый адрес не роняем.
const exchangeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/exchange',
  beforeLoad: () => {
    throw redirect({ to: '/statistics' });
  },
});
const obligationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/obligations',
  component: Obligations,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: Settings,
});
// Демо без регистрации (#56): единственный экран, который не требует сессии — он её и получает.
const demoRoute = createRoute({ getParentRoute: () => rootRoute, path: '/demo', component: Demo });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  todayRoute,
  planRoute,
  historyRoute,
  statisticsRoute,
  exchangeRoute,
  obligationsRoute,
  settingsRoute,
  demoRoute,
]);

/**
 * Ошибка внутри маршрута до внешней границы не доходит — роутер ловит её сам и по умолчанию
 * показывает свой отладочный экран «Something went wrong». Человеку он ничего не объясняет, а
 * отчёт никуда не уходит; ставим свой.
 */
function RouteError({ error }: { error: Error }) {
  reportError(error, window.location.pathname);
  return <ErrorScreen />;
}

export const router = createRouter({ routeTree, defaultErrorComponent: RouteError });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
