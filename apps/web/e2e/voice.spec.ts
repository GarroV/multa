import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Диктовка траты (#107). Ручка `/transactions/voice` жила с самого начала и была покрыта тестами
 * на сервере, но кнопки к ней не было: ручка оплачивалась и не приносила пользы.
 *
 * Настоящий микрофон в тесте недоступен, а отправлять в Whisper тишину — значит жечь ключ ради
 * зелёной галочки. Поэтому ответ ручки подменяется: проверяем то, что было сломано, — что кнопка
 * существует, запись начинается и её результат раскладывается по полям формы. Сам разбор звука
 * проверен на сервере.
 */
test.use({
  permissions: ['microphone'],
  // Настоящего микрофона в headless нет: браузеру подсовывается фейковое устройство, иначе
  // getUserMedia отказывает и кнопка молча остаётся в «idle».
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

test('надиктованное раскладывается по полям формы (#107)', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);

  await page.route('**/v1/transactions/voice', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'llm',
        kind: 'expense',
        amountMinor: '73500',
        currency: 'RUB',
        occurredOn: new Date().toISOString().slice(0, 10),
        categoryId: null,
        categoryName: null,
        note: 'такси до аэропорта',
        transcript: 'такси до аэропорта 735',
      }),
    }),
  );

  await page.locator('.act-primary').click();
  const sheet = page.locator('.sheet');
  const mic = sheet.getByRole('button', { name: /Dictate|Надиктовать/ });
  await expect(mic).toBeVisible();

  await mic.click();
  // Запись пошла: кнопка переключилась в «стоп».
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await mic.click();

  // Расшифровка встала в умное поле — человек видит, КАК его услышали.
  await expect(sheet.locator('input[placeholder*="4.5 eur"]')).toHaveValue(
    'такси до аэропорта 735',
    { timeout: 15_000 },
  );
  await expect(sheet.locator('input[placeholder="0"]')).toHaveValue('735.00');
});
