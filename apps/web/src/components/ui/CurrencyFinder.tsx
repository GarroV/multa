import { useMemo, useRef, useState } from 'react';
import { CURRENCY_CODES } from '@multa/core';
import { useI18n } from '../../lib/i18n.tsx';

/**
 * Поиск валюты по коду или названию (запрос владельца 22.08.2026).
 *
 * Раньше валюту в настройках добавляли, набрав три буквы в поле и нажав «Добавить»: код надо было
 * знать заранее, а опечатка молча давала строку, для которой нет курса. Теперь человек вводит
 * «евро», «eur» или «динар» и выбирает из подсказок — код подставляет продукт.
 *
 * Названия берём у `Intl.DisplayNames`, а не из своего словаря: браузер знает их на языке
 * интерфейса, и 160 позиций × два языка не нужно поддерживать руками. Ищем сразу по двум языкам —
 * человек, живущий между валютами, набирает то «динар», то «dinar», и заставлять его угадывать
 * язык интерфейса значит вернуть ту же проблему, что и с кодом.
 */

/** Сколько подсказок показываем: список длиннее человек всё равно не читает, а уточняет запрос. */
const MAX_HITS = 8;

function displayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' });
  } catch {
    // Старый движок без DisplayNames: поиск останется по коду, но поле не сломается.
    return null;
  }
}

export function CurrencyFinder({
  onPick,
  exclude = [],
  disabled = false,
  label,
  placeholder,
}: {
  onPick: (code: string) => void;
  /** Уже выбранные — их в подсказках не показываем: выбрать второй раз всё равно нельзя. */
  exclude?: readonly string[];
  disabled?: boolean;
  label: string;
  placeholder: string;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /*
   * Названия считаем один раз на локаль, а не на каждый ввод символа: `DisplayNames.of` дешёвый, но
   * 160 вызовов на каждое нажатие клавиши — уже заметная работа на телефоне.
   */
  const names = useMemo(() => {
    const own = displayNames(locale);
    const other = displayNames(locale === 'ru' ? 'en' : 'ru');
    return CURRENCY_CODES.map((code) => ({
      code,
      /** На языке интерфейса — это и показываем рядом с кодом. */
      name: own?.of(code) ?? code,
      /** На втором языке — только для поиска, на экран не выводим. */
      alt: other?.of(code) ?? code,
    }));
  }, [locale]);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const free = names.filter((c) => !exclude.includes(c.code));
    const match = free.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.alt.toLowerCase().includes(q),
    );
    /*
     * Точное совпадение кода — первым. Иначе «RUB» тонет среди валют, в чьих названиях встречается
     * «rub» (Rubla, Rupiah), и человек, набравший ровно код, ищет его глазами в списке.
     */
    const exact = match.filter((c) => c.code.toLowerCase() === q);
    const rest = match.filter((c) => c.code.toLowerCase() !== q);
    return [...exact, ...rest].slice(0, MAX_HITS);
  }, [names, query, exclude]);

  const pick = (code: string) => {
    onPick(code);
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  };

  return (
    <span className="ccyfind">
      <input
        ref={inputRef}
        className="field ccyfind-input"
        aria-label={label}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-autocomplete="list"
        aria-controls="ccyfind-list"
        autoComplete="off"
        disabled={disabled}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, hits.length - 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            const hit = hits[active];
            if (hit) pick(hit.code);
          }
          // Escape очищает запрос, а не закрывает панель настроек: лист тут ни при чём.
          if (e.key === 'Escape' && query) {
            e.preventDefault();
            e.stopPropagation();
            setQuery('');
          }
        }}
      />
      {query.trim() !== '' && (
        <span className="ccyfind-drop" id="ccyfind-list" role="listbox">
          {hits.length === 0 && <span className="ccyfind-empty">{t('set.currency.notFound')}</span>}
          {hits.map((hit, i) => (
            <button
              key={hit.code}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? 'ccyfind-item is-active' : 'ccyfind-item'}
              /* mousedown, а не click: click приходит после blur, и поле успевает потерять фокус. */
              onMouseDown={(e) => {
                e.preventDefault();
                pick(hit.code);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <b className="mono">{hit.code}</b>
              <span className="dim">{hit.name}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
