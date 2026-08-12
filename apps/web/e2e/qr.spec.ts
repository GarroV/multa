import { expect, test } from '@playwright/test';
import { enterDemo, resetDemo } from './helpers.ts';

/**
 * Сканирование QR чека (#107).
 *
 * Парсеры ФНС РФ и suf.purs.gov.rs были готовы и покрыты тестами, но содержимое QR человек
 * перепечатывал РУКАМИ с бумажки — смысл этого пути был ровно в обратном, в одном движении
 * телефоном. Путь обязателен: он бесплатный, в отличие от vision через OpenAI.
 *
 * Настоящей камеры в headless нет, поэтому браузеру подсовывается фейковое устройство, а чтобы в
 * кадре был именно наш код — getUserMedia подменяется потоком с канваса, на который нанесена
 * фикстура с заранее сгенерированным QR. Так проверяется вся цепочка: кадр → jsQR → разбор → ревью-экран.
 */
test.use({
  permissions: ['camera'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

/*
 * Картинка кода лежит фикстурой, а не тянется из сети: тест, которому нужен интернет, однажды
 * упадёт не из-за кода, и это будет выглядеть как поломка продукта.
 */
const QR_IMAGE = `data:image/png;base64,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`;

/** Содержимое чека ФНС: те самые реквизиты, которые иначе набирают вручную. */
const FNS_PAYLOAD = 't=20260810T1230&s=1234.56&fn=9280440300000000&i=12345&fp=1234567890&n=1';

test('код из кадра камеры разбирается без единой набранной буквы (#107)', async ({ page }) => {
  await resetDemo(page);
  await enterDemo(page);

  // Подменяем поток камеры канвасом с нарисованным QR: фейковое устройство Chromium показывает
  // тестовую картинку, кода на ней нет.
  await page.addInitScript((dataUrl: string) => {
    const draw = async (): Promise<HTMLCanvasElement> => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d')!.drawImage(image, 0, 0);
      return canvas;
    };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (!constraints?.video) return await original(constraints);
      const canvas = await draw();
      return (
        canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }
      ).captureStream(10);
    };
  }, QR_IMAGE);

  await page.reload();
  await page.getByRole('button', { name: /^Receipt$|^Чек$/ }).click();
  const sheet = page.locator('.sheet');
  await expect(sheet).toBeVisible();

  /*
   * Смотрим на запрос, а не на поле: удачный разбор сразу уводит на ревью-экран, и поле ввода
   * исчезает вместе с формой. Тело запроса доказывает всю цепочку — кадр камеры дошёл до сервера
   * без единой набранной буквы, а что сервер сделает дальше, проверено его тестами.
   */
  const sent = page.waitForRequest(
    (r) => r.url().includes('/v1/receipts/qr') && r.method() === 'POST',
    { timeout: 20_000 },
  );
  await sheet.getByRole('button', { name: /Point the camera|Навести камеру/ }).click();
  expect((await sent).postDataJSON()).toMatchObject({ payload: FNS_PAYLOAD });
});
