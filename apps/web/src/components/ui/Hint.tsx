import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n.tsx';

/**
 * Справка под вопросительным знаком (решение владельца 11.08.2026).
 *
 * Пояснения занимали строку под каждой формой навсегда, хотя нужны один раз: человек, который уже
 * понял, что такое «Осталось», читает эту строку каждый раз, когда заводит долг. Плотный экран
 * живёт тем, что на нём нет ничего лишнего, — поэтому справка сворачивается в знак.
 *
 * Текст показывается ПО НАЖАТИЮ, а не нативной подсказкой браузера (жалоба владельца 22.08.2026:
 * «справка там не работает»). Раньше это был `title`: он появляется через секунду ожидания, не
 * стилизуется, обрезается на длинном тексте и полностью отсутствует на тач-экране — то есть на
 * телефоне справки не было вовсе, а на десктопе её надо было угадать. Знак «?», который ничего не
 * делает по нажатию, читается как сломанный.
 *
 * Закрывается повторным нажатием, Escape и нажатием мимо. `aria-expanded` + `role="note"` дают
 * экранному читателю то же поведение, что видит глаз: кнопка, раскрывающая пояснение.
 */
export function Hint({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      /*
       * Escape гасит только справку и не всплывает выше: тем же нажатием закрываются листы ввода, и
       * человек, свернувший подсказку, терял бы вместе с ней введённое.
       */
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="hint-wrap" ref={wrapRef}>
      <button
        type="button"
        className="hint"
        aria-expanded={open}
        aria-controls={id}
        aria-label={t('common.help')}
        onClick={() => setOpen((v) => !v)}
      >
        {/*
          Знак в отдельном элементе: сама кнопка — область нажатия (22px, как у остальных
          компактных действий), а кружок остаётся мелким. Иначе выбор был бы между «крупный
          вопросительный знак спорит с подписью» и «по знаку промахиваются пальцем».
        */}
        <span className="hint-mark" aria-hidden>
          ?
        </span>
      </button>
      {open && (
        <span className="hint-pop" id={id} role="note">
          {text}
        </span>
      )}
    </span>
  );
}
