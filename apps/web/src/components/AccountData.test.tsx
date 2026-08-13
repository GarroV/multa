import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../lib/i18n.tsx';
import { AccountData } from './AccountData.tsx';

/**
 * Компонентный тест необратимого действия (issue #17).
 *
 * Удаление аккаунта уносит воркспейс со всеми деньгами и не откатывается. Единственное, что стоит
 * между человеком и этим, — совпадение введённой почты, поэтому проверять его надо дёшево и часто,
 * а не одним браузерным сценарием, который однажды выключат из-за медленности.
 */
function show(email: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <AccountData email={email} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const deleteButtons = () => screen.getAllByRole('button', { name: /^Удалить$|^Delete$/ });

describe('AccountData', () => {
  it('удаление спрятано за подтверждением, а не висит кнопкой', async () => {
    const user = userEvent.setup();
    show('me@multa.local');
    // До нажатия поля подтверждения нет вовсе: необратимое не должно быть в одном клике.
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(deleteButtons()[0]!);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('кнопка неактивна, пока почта не совпала', async () => {
    const user = userEvent.setup();
    show('me@multa.local');
    await user.click(deleteButtons()[0]!);
    const confirm = screen.getByRole('textbox');
    const submit = deleteButtons().at(-1)!;

    expect(submit).toBeDisabled();
    await user.type(confirm, 'someone@else.test');
    expect(submit).toBeDisabled();
  });

  it('регистр и пробелы не мешают: человек вводит почту, а не строку байтов', async () => {
    const user = userEvent.setup();
    show('me@multa.local');
    await user.click(deleteButtons()[0]!);
    await user.type(screen.getByRole('textbox'), '  ME@Multa.Local  ');
    expect(deleteButtons().at(-1)!).toBeEnabled();
  });

  it('без известной почты удалить нельзя вовсе', async () => {
    const user = userEvent.setup();
    show(null);
    await user.click(deleteButtons()[0]!);
    await user.type(screen.getByRole('textbox'), 'что угодно');
    // Иначе пустое поле совпало бы с пустой почтой, и подтверждения не было бы никакого.
    expect(deleteButtons().at(-1)!).toBeDisabled();
  });

  it('отмена убирает поле и не оставляет введённое', async () => {
    const user = userEvent.setup();
    show('me@multa.local');
    await user.click(deleteButtons()[0]!);
    await user.type(screen.getByRole('textbox'), 'me@multa.local');
    await user.click(screen.getByRole('button', { name: /^Отмена$|^Cancel$/ }));
    expect(screen.queryByRole('textbox')).toBeNull();

    await user.click(deleteButtons()[0]!);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});
