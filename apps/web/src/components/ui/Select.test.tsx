import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n.tsx';
import { Select } from './Select.tsx';

/**
 * Компонентные тесты выпадающего списка (issue #17).
 *
 * Проверяется поведение, а не разметка: нативный `<select>` давал клавиатуру и экранный читатель
 * бесплатно, и заменив его своим (жалоба владельца 13.08.2026 на системный вид), мы обязаны их
 * вернуть. Браузерный сценарий это уже покрывает, но здесь дешевле проверять углы — пустой список,
 * значение вне списка, Esc без выбора, — а в E2E такие проверки стоили бы минуты прогона.
 */
const options = [
  { value: 'a', label: 'Первый' },
  { value: 'b', label: 'Второй' },
  { value: 'c', label: 'Третий' },
];

function open(value = 'a', onChange = vi.fn()) {
  render(
    <I18nProvider>
      <Select value={value} options={options} onChange={onChange} label="Выбор" />
    </I18nProvider>,
  );
  return { trigger: screen.getByRole('button', { name: 'Выбор' }), onChange };
}

describe('Select', () => {
  it('показывает подпись выбранного, а не его значение', () => {
    const { trigger } = open('b');
    expect(trigger).toHaveTextContent('Второй');
  });

  it('стрелка вниз и Enter выбирают следующий', async () => {
    const user = userEvent.setup();
    const { trigger, onChange } = open('a');
    await user.click(trigger);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('Esc закрывает и ничего не меняет', async () => {
    const user = userEvent.setup();
    const { trigger, onChange } = open('a');
    await user.click(trigger);
    await user.keyboard('{ArrowDown}{Escape}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('End ведёт к последнему, Home — к первому', async () => {
    const user = userEvent.setup();
    const { trigger, onChange } = open('a');
    await user.click(trigger);
    await user.keyboard('{End}{Enter}');
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('список объявлен как listbox, а выбранный — как выбранный', async () => {
    const user = userEvent.setup();
    const { trigger } = open('b');
    await user.click(trigger);
    const list = screen.getByRole('listbox');
    expect(list).toBeInTheDocument();
    // Экранный читатель узнаёт текущее значение из aria-selected, а не из цвета строки.
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Второй');
  });

  it('значение вне списка показывается как есть, а не подменяется первым', () => {
    // Так бывает у валюты, которой нет в списке воркспейса: молча подменить — потерять данные.
    const { trigger } = open('неизвестное');
    expect(trigger).toHaveTextContent('неизвестное');
  });

  it('пустой список не роняет экран', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Select value="" options={[]} onChange={vi.fn()} label="Пусто" />
      </I18nProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Пусто' }));
    expect(screen.getByRole('listbox')).toBeEmptyDOMElement();
  });
});
