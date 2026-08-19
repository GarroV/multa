import { useSettings } from '../../lib/queries.ts';
import { Select } from './Select.tsx';

/**
 * Выбор валюты списком вместо ввода трёх букв руками (решение владельца 06.08.2026).
 *
 * Поле было текстовым, и это ошибка ввода, ждущая своего часа: «евро» набирают как EUR, EURO и
 * даже ЕУР в русской раскладке, а неверный код молча даёт строку, для которой нет курса, — она
 * попадает в «нерешённые» и выпадает из плана. Список закрывает класс ошибок целиком.
 *
 * Список берётся из настроек воркспейса (`currency.list`): у каждого он свой — рубли с тенге у
 * одного, евро с сомами у другого. Здешний массив — только дефолт на время загрузки настроек и для
 * случая, когда их ещё нет; правда о списке живёт на сервере, в одном месте с остальными
 * настройками. Полный справочник ISO сюда не годится: в выпадашке из ста семидесяти позиций нужную
 * ищут дольше, чем набирают руками.
 */
const FALLBACK = ['RUB', 'EUR', 'USD', 'RSD', 'KGS', 'KZT'];

/*
 * В списке — только код валюты, без расшифровки (решение владельца 06.08.2026). «RUB · рубль»
 * занимает втрое больше места в плотной строке формы, а трёхбуквенный код человек, живущий между
 * валютами, читает и так.
 */

export function CurrencySelect({
  value,
  onChange,
  label,
  className = 'field field-ccy-wide',
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  className?: string;
}) {
  const { data: settings } = useSettings();
  const list = settings?.currency.list?.length ? settings.currency.list : FALLBACK;
  /*
   * Валюта, которой нет в списке, но которая уже стоит в строке, обязана в списке появиться: иначе
   * открытие редактора молча подменило бы её первой из списка. Так теряют данные.
   */
  const options = list.includes(value) ? list : [value, ...list].filter(Boolean);

  return (
    <Select
      className={className}
      label={label}
      value={value}
      onChange={onChange}
      options={options.map((code) => ({ value: code, label: code }))}
    />
  );
}
