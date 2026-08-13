import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary.tsx';

/**
 * Компонентный тест границы ошибок (issue #17).
 *
 * Браузерный сценарий проверяет, что человек видит объяснение вместо белого экрана. Здесь дешевле
 * проверить второе свойство, ради которого граница и делалась: отчёт доезжает до сервера. Иначе мы
 * так и не узнаём о поломках — они умирают в консоли посетителя.
 */
function Boom(): never {
  throw new Error('сломалось на рендере');
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React печатает пойманную ошибку в консоль — в выводе тестов это шум, а не сигнал.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('целое дерево показывается, пока никто не падает', () => {
    render(
      <ErrorBoundary>
        <span>всё хорошо</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText('всё хорошо')).toBeInTheDocument();
  });

  it('падение заменяется объяснением и кнопкой, а не пустотой', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Что-то сломалось/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Перезагрузить/ })).toBeInTheDocument();
  });

  it('отчёт уходит на сервер и несёт текст ошибки', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain('/v1/client-errors');
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as { message: string };
    expect(body.message).toContain('сломалось на рендере');
  });

  it('упавшая отправка отчёта не роняет экран ошибки', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сети нет')));
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    // Показать человеку ошибку об ошибке — значит потерять его окончательно.
    expect(screen.getByText(/Что-то сломалось/)).toBeInTheDocument();
  });
});
