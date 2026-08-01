import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { anonymous, expectOk, signedUp, type TestClient } from './client.ts';

/**
 * Двухфакторный вход (issue #19).
 *
 * Проверяется то, ради чего 2FA и существует: после включения пароля недостаточно. И обратное,
 * не менее важное: пока код из приложения не подтверждён, двухфакторка НЕ включена — иначе человек
 * запирает себя снаружи, а узнаёт об этом на следующем входе.
 *
 * Код считается здесь настоящим алгоритмом TOTP (RFC 6238) по секрету из otpauth-ссылки: мок
 * проверил бы только то, что мы умеем звать свою же заглушку.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32 → байты. Секрет в otpauth-ссылке лежит именно так. */
function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Шестизначный TOTP по RFC 6238: HMAC-SHA1, окно 30 секунд. */
function totp(secret: string, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    (((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff)) %
    1_000_000;
  return String(code).padStart(6, '0');
}

const PASSWORD = 'IntegrationTest123!';

interface EnableDto {
  totpURI: string;
  backupCodes: string[];
}

const secretOf = (totpURI: string): string => new URL(totpURI).searchParams.get('secret') ?? '';

/** Включает 2FA и возвращает секрет с резервными кодами. */
async function enable(client: TestClient): Promise<EnableDto & { secret: string }> {
  const dto = await expectOk<EnableDto>(
    await client.post('/v1/auth/two-factor/enable', { password: PASSWORD }),
  );
  return { ...dto, secret: secretOf(dto.totpURI) };
}

describe('двухфакторный вход', () => {
  test('включение выдаёт ссылку для приложения и резервные коды', async () => {
    const client = await signedUp();
    const { totpURI, backupCodes, secret } = await enable(client);

    expect(totpURI.startsWith('otpauth://totp/')).toBe(true);
    expect(secret.length).toBeGreaterThan(15);
    // Резервные коды — единственный выход при потерянном телефоне: их обязано быть несколько.
    expect(backupCodes.length).toBeGreaterThan(1);
  });

  test('неверный пароль не включает 2FA', async () => {
    const client = await signedUp();
    const res = await client.post('/v1/auth/two-factor/enable', { password: 'wrong-password' });
    expect(res.status).toBe(400);
  });

  test('после подтверждения кодом пароля для входа уже недостаточно', async () => {
    const client = await signedUp();
    const { secret } = await enable(client);
    await expectOk(await client.post('/v1/auth/two-factor/verify-totp', { code: totp(secret) }));

    // Вход с правильным паролем: сессии нет, сервер просит второй фактор.
    const fresh = anonymous();
    const signIn = await fresh.post('/v1/auth/sign-in/email', {
      email: client.email,
      password: PASSWORD,
    });
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    // Пока код не введён, защищённые ручки закрыты.
    expect((await fresh.get('/v1/me')).status).toBe(401);

    // Код из приложения — и вход состоялся.
    await expectOk(await fresh.post('/v1/auth/two-factor/verify-totp', { code: totp(secret) }));
    expect((await fresh.get('/v1/me')).status).toBe(200);
  });

  test('чужой код не пускает', async () => {
    const client = await signedUp();
    const { secret } = await enable(client);
    await expectOk(await client.post('/v1/auth/two-factor/verify-totp', { code: totp(secret) }));

    const fresh = anonymous();
    await fresh.post('/v1/auth/sign-in/email', { email: client.email, password: PASSWORD });
    const bad = await fresh.post('/v1/auth/two-factor/verify-totp', { code: '000000' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await fresh.get('/v1/me')).status).toBe(401);
  });

  test('резервный код пускает один раз', async () => {
    const client = await signedUp();
    const { secret, backupCodes } = await enable(client);
    await expectOk(await client.post('/v1/auth/two-factor/verify-totp', { code: totp(secret) }));

    const fresh = anonymous();
    await fresh.post('/v1/auth/sign-in/email', { email: client.email, password: PASSWORD });
    await expectOk(
      await fresh.post('/v1/auth/two-factor/verify-backup-code', { code: backupCodes[0] }),
    );
    expect((await fresh.get('/v1/me')).status).toBe(200);

    // Тот же код повторно не работает: одноразовость — половина смысла резервного кода.
    const again = anonymous();
    await again.post('/v1/auth/sign-in/email', { email: client.email, password: PASSWORD });
    const reuse = await again.post('/v1/auth/two-factor/verify-backup-code', {
      code: backupCodes[0],
    });
    expect(reuse.status).toBeGreaterThanOrEqual(400);
  });

  test('выключение возвращает вход по одному паролю', async () => {
    const client = await signedUp();
    const { secret } = await enable(client);
    await expectOk(await client.post('/v1/auth/two-factor/verify-totp', { code: totp(secret) }));
    await expectOk(await client.post('/v1/auth/two-factor/disable', { password: PASSWORD }));

    const fresh = anonymous();
    const signIn = await fresh.post('/v1/auth/sign-in/email', {
      email: client.email,
      password: PASSWORD,
    });
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).not.toMatchObject({ twoFactorRedirect: true });
    expect((await fresh.get('/v1/me')).status).toBe(200);
  });
});
