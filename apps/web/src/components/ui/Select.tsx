import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Выпадающий список в языке продукта (жалоба владельца 13.08.2026: «выглядит как стандартная
 * справка от системы», «положение прыгает»).
 *
 * Нативный `<select>` рисует список сама операционная система: свой шрифт, свой синий, свои отбивки.
 * Внутри плотной тёмной таблицы это выглядело чужеродно, и подчинить его нельзя — попап не часть
 * страницы. Поэтому список свой.
 *
 * Попап уходит в портал на body, а не позиционируется внутри строки: `.panel` обрезает содержимое
 * (`overflow: hidden`), и список внутри панели резался бы по её краю. Позиция считается от кнопки и
 * пересчитывается при прокрутке и изменении размера — иначе список «уезжает» от своего поля.
 *
 * Доступность не приложена сбоку, а составляет половину смысла: нативный select давал клавиатуру и
 * экранный читатель бесплатно, и заменяя его, мы обязаны их вернуть — иначе это шаг назад, а не
 * вперёд. Роли combobox/listbox/option, стрелки, Home/End, Enter, Esc с возвратом фокуса.
 */

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** Высота одной строки списка — из неё же считается, поместится ли попап под кнопкой. */
const ROW_HEIGHT = 32;
const MAX_ROWS = 8;

export function Select({
  value,
  options,
  onChange,
  label,
  className = 'field',
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (next: string) => void;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const listId = useId();

  const current = options.find((o) => o.value === value);

  const place = () => {
    const el = trigger.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const height = Math.min(options.length, MAX_ROWS) * ROW_HEIGHT + 8;
    // Не хватает места снизу — открываем вверх. Список, уехавший за экран, равен отсутствию списка.
    const below = window.innerHeight - box.bottom;
    const top = below < height && box.top > height ? box.top - height - 4 : box.bottom + 4;
    setRect({ top, left: box.left, width: box.width });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Прокрутка и ресайз двигают кнопку, а попап живёт в портале и сам об этом не узнает.
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options.length]);

  /*
   * Фокус даём после того, как попап смонтирован. Он рендерится только при известной позиции
   * (`open && rect`), поэтому на первом кадре после открытия списка ещё нет — и фокус уходил в
   * никуда, а клавиатура не работала вовсе. Поймано браузерным тестом.
   */
  useEffect(() => {
    if (open && rect) list.current?.focus();
  }, [open, rect]);

  const close = (returnFocus = true) => {
    setOpen(false);
    // Фокус возвращается на кнопку: иначе после выбора он улетает в body и клавиатурный путь рвётся.
    if (returnFocus) trigger.current?.focus();
  };

  const pick = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(active);
      return;
    }
    const moves: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowUp: active - 1,
      Home: 0,
      End: options.length - 1,
    };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(options.length - 1, next)));
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${className} sel-trigger`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setActive(
            Math.max(
              0,
              options.findIndex((o) => o.value === value),
            ),
          );
          setOpen((v) => !v);
        }}
      >
        <span className="sel-value">{current?.label ?? value}</span>
        <span className="sel-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open &&
        rect &&
        createPortal(
          <>
            {/* Подложка ловит клик мимо списка. Без неё список закрывался бы только клавишей. */}
            <div className="sel-backdrop" onMouseDown={() => close(false)} />
            <ul
              ref={list}
              id={listId}
              className="sel-list"
              role="listbox"
              aria-label={label}
              aria-activedescendant={`${listId}-${active}`}
              tabIndex={-1}
              onKeyDown={onKeyDown}
              style={{ top: rect.top, left: rect.left, minWidth: rect.width }}
            >
              {options.map((option, i) => (
                <li
                  key={option.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={option.value === value}
                  className={i === active ? 'sel-item is-active' : 'sel-item'}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                >
                  <span className="sel-check" aria-hidden>
                    {option.value === value ? '·' : ''}
                  </span>
                  {option.label}
                </li>
              ))}
            </ul>
          </>,
          document.body,
        )}
    </>
  );
}
