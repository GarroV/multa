import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { TranslationKey } from '@multa/i18n';
import { useI18n } from '../../lib/i18n.tsx';

/**
 * Обучающий тур по главному экрану (issue #28).
 *
 * Смысл замены визарда: человек отвечал на вопросы про долги и валютные корзины, **ещё не увидев
 * продукт**, — и отвечал наугад. Теперь он сразу видит план на своих числах, а подсказки объясняют
 * блоки на месте.
 *
 * Три требования, из которых следует устройство:
 *
 * 1. **Подсветка не двигает вёрстку.** Дырка в затемнении собирается из четырёх прямоугольников
 *    поверх страницы; сам подсвечиваемый блок не получает ни рамки, ни отступов — иначе он
 *    «прыгал» бы при переходе между шагами.
 * 2. **Шаг — это данные, а не разметка.** Новый блок дашборда добавляет строку в список шагов и
 *    не трогает движок.
 * 3. **Шаг без якоря пропускается.** У человека без долгов нет панели долгов — рассказывать про
 *    неё некому, и упираться в несуществующий элемент тур не должен.
 */

export interface TourStep {
  readonly id: string;
  /** CSS-селектор блока, о котором рассказываем. */
  readonly anchor: string;
  readonly title: TranslationKey;
  readonly body: TranslationKey;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Отступ дырки от блока: подсветка должна дышать, иначе читается как рамка. */
const PAD = 6;
/** Зазор между дыркой и подсказкой. */
const GAP = 12;
const TIP_WIDTH = 300;

function rectOf(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return {
    top: r.top - PAD,
    left: r.left - PAD,
    width: r.width + PAD * 2,
    height: r.height + PAD * 2,
  };
}

export function Tour({ steps, onFinish }: { steps: readonly TourStep[]; onFinish: () => void }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const step = steps[index];

  /** Пересчёт дырки: положение блока меняется от скролла, поворота и загрузки данных. */
  const measure = useCallback(() => {
    if (!step) return;
    setRect(rectOf(step.anchor));
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return;
    const el = document.querySelector(step.anchor);
    // Блок может быть ниже сгиба: подводим его к глазам, а уже потом меряем.
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    measure();
    const timer = setTimeout(measure, 350);
    return () => clearTimeout(timer);
  }, [step, measure]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  const next = useCallback(() => {
    if (index + 1 >= steps.length) return onFinish();
    setIndex(index + 1);
  }, [index, steps.length, onFinish]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFinish();
      if (e.key === 'Enter' || e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, onFinish]);

  // Шаг без якоря пропускаем молча: у человека без долгов панели долгов и нет.
  useEffect(() => {
    if (step && rect === null) {
      const timer = setTimeout(() => {
        if (rectOf(step.anchor) === null) next();
      }, 400);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [step, rect, next]);

  if (!step || !rect) return null;

  const belowSpace = window.innerHeight - (rect.top + rect.height);
  const below = belowSpace > 180;
  const tipTop = below ? rect.top + rect.height + GAP : Math.max(GAP, rect.top - 180 - GAP);
  const tipLeft = Math.min(
    Math.max(GAP, rect.left),
    Math.max(GAP, window.innerWidth - TIP_WIDTH - GAP),
  );

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={t(step.title)}>
      {/* Четыре полосы вокруг дырки: сам блок ничем не накрыт и остаётся кликабельным. */}
      <div
        className="tour-mask"
        style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top) }}
      />
      <div
        className="tour-mask"
        style={{ top: rect.top + rect.height, left: 0, right: 0, bottom: 0 }}
      />
      <div
        className="tour-mask"
        style={{ top: rect.top, left: 0, width: Math.max(0, rect.left), height: rect.height }}
      />
      <div
        className="tour-mask"
        style={{ top: rect.top, left: rect.left + rect.width, right: 0, height: rect.height }}
      />
      <div
        className="tour-ring"
        style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      />

      <div className="tour-tip" style={{ top: tipTop, left: tipLeft, width: TIP_WIDTH }}>
        <div className="tour-step">
          {index + 1} / {steps.length}
        </div>
        <div className="tour-title">{t(step.title)}</div>
        <div className="tour-body">{t(step.body)}</div>
        <div className="tour-acts">
          <button type="button" className="btn btn-ghost" onClick={onFinish}>
            {t('tour.skip')}
          </button>
          <button type="button" className="btn" onClick={next}>
            {t(index + 1 >= steps.length ? 'tour.done' : 'tour.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
