import { Component, type ErrorInfo, type ReactNode } from 'react';
import { API_ORIGIN } from '../lib/apiUrl.ts';

/**
 * Отправка отчёта об ошибке на нашу же ручку (Спринт 6).
 *
 * Sentry SaaS не берём: профиль нулевой стоимости запрещает платные сервисы и вторые ключи, а
 * docs/03-architecture.md прямо предусматривает self-hosted или «пока без него». Ручка даёт то,
 * ради чего Sentry и нужен: ошибка не умирает в консоли посетителя, а доезжает до логов.
 *
 * «Выстрелил и забыл»: если упала и отправка, показывать человеку ошибку об ошибке — значит
 * потерять его окончательно. `keepalive` нужен, чтобы отчёт пережил перезагрузку, которую человек
 * нажмёт первой.
 */
export function reportError(error: Error, where: string): void {
  void fetch(`${API_ORIGIN}/v1/client-errors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      message: `${error.name}: ${error.message}\n${error.stack ?? ''}`,
      where,
    }),
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * Экран вместо белой страницы.
 *
 * Текст без i18n намеренно: провайдер словаря сам может быть частью упавшего дерева, и попытка
 * перевести сообщение об ошибке уронила бы экран ошибки. Обе фразы — рядом, коротко.
 */
export function ErrorScreen() {
  return (
    <div className="page-center-full stack-xs">
      <div className="title-md">Что-то сломалось · Something broke</div>
      <span className="sub dim">
        Данные целы, мы уже знаем · Your data is safe, we have been notified
      </span>
      <button type="button" className="btn" onClick={() => window.location.reload()}>
        Перезагрузить · Reload
      </button>
    </div>
  );
}

/**
 * Граница ошибок для того, что вне маршрутов: провайдеры, сам роутер, монтирование.
 *
 * Ошибки ВНУТРИ маршрута до неё не доходят — их перехватывает роутер своим обработчиком, поэтому
 * тот настроен отдельно (`defaultErrorComponent`). Без обоих любая ошибка рендера превращала
 * приложение в белый экран, а мы не узнавали о ней никогда.
 *
 * Классовый компонент здесь не выбор стиля: функционального эквивалента `componentDidCatch` нет.
 */
interface State {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, info.componentStack?.split('\n')[1]?.trim() ?? window.location.pathname);
  }

  override render(): ReactNode {
    return this.state.failed ? <ErrorScreen /> : this.props.children;
  }
}
