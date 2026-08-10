import type { TranslationKey } from '@multa/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { authClient } from '../lib/authClient.ts';
import { useI18n } from '../lib/i18n.tsx';

/**
 * Ответ better-auth на человеческий язык.
 *
 * Библиотека отдаёт свой текст по-английски, и мы показывали его как есть: русскоязычный человек,
 * у которого аккаунт уже есть, видел «User already exists. Use another email.» и понимал это как
 * «зарегистрироваться нельзя» (жалоба живого пользователя 10.08.2026). Код ответа стабильнее
 * текста, поэтому переводим по коду, а сырое сообщение оставляем последним рубежом — молчать в
 * незнакомом случае хуже, чем показать английскую строку.
 */
const AUTH_ERROR_KEYS: Record<string, TranslationKey> = {
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'auth.err.taken',
  USER_ALREADY_EXISTS: 'auth.err.taken',
  INVALID_EMAIL_OR_PASSWORD: 'auth.err.badCredentials',
  PASSWORD_TOO_SHORT: 'auth.err.shortPassword',
  INVALID_EMAIL: 'auth.err.badEmail',
  TOO_MANY_REQUESTS: 'auth.err.tooMany',
};

export function Login() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'in' | 'up'>('up');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  /* Почта занята: показываем не только текст, но и путь дальше — кнопку входа с той же почтой. */
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  /*
   * Шаг проверки TOTP (issue #19). better-auth на этом шаге уже удалил сессионную куку и выдал
   * временную 2FA-куку на 10 минут: пароль принят, но входа ещё нет. Поэтому форма не «переходит
   * дальше», а меняется на месте — уводить человека редиректом с формы, где он стоит, незачем.
   */
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState('');
  const [backupMode, setBackupMode] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setTaken(false);
    const res =
      mode === 'up'
        ? await authClient.signUp.email({ email, password, name })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      const key = res.error.code ? AUTH_ERROR_KEYS[res.error.code] : undefined;
      setError(key ? t(key) : (res.error.message ?? t('auth.err.unknown')));
      // Занятая почта — не ошибка ввода, а развилка: человеку нужен вход, а не другая почта.
      setTaken(res.error.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL');
      return;
    }
    if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setNeedCode(true);
      return;
    }
    await qc.invalidateQueries({ queryKey: ['me'] });
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = backupMode
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? t('twofa.badCode'));
      return;
    }
    setCode('');
    setNeedCode(false);
    await qc.invalidateQueries({ queryKey: ['me'] });
  }

  if (needCode) {
    return (
      <div className="page-center">
        <form onSubmit={submitCode} className="card auth-form">
          <div>
            <div className="brand brand-lg">{t('twofa.signInTitle')}</div>
            <div className="dim note-tight">{t('twofa.signInHint')}</div>
          </div>
          <input
            className="field num"
            inputMode={backupMode ? 'text' : 'numeric'}
            autoFocus
            placeholder={backupMode ? 'XXXXXXXXXX' : '000000'}
            aria-label={t('twofa.code')}
            value={code}
            onChange={(e) =>
              setCode(backupMode ? e.target.value : e.target.value.replace(/\D/g, ''))
            }
            required
          />
          {!backupMode && (
            <label className="row row-check">
              <input
                type="checkbox"
                checked={trustDevice}
                onChange={(e) => setTrustDevice(e.target.checked)}
              />
              <span className="sub">{t('twofa.trustDevice')}</span>
            </label>
          )}
          {error && <div className="danger err-line">{error}</div>}
          <button className="btn" type="submit" disabled={busy || code.length === 0}>
            {busy ? t('common.loading') : t('twofa.confirm')}
          </button>
          {/* Резервный код — единственный выход, если телефон потерян: прятать его нельзя. */}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setBackupMode((v) => !v);
              setCode('');
              setError(null);
            }}
          >
            {t(backupMode ? 'twofa.useTotp' : 'twofa.useBackup')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="page-center">
      <form onSubmit={submit} className="card auth-form">
        <div>
          <div className="brand brand-lg">{t('auth.title')}</div>
          <div className="dim note-tight">{t('auth.subtitle')}</div>
        </div>
        {mode === 'up' && (
          <input
            className="field"
            placeholder={t('auth.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}
        <input
          className="field"
          type="email"
          placeholder={t('auth.email')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="field"
          type="password"
          placeholder={t('auth.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        {error && <div className="danger err-line">{error}</div>}
        {/* Отказ без пути дальше и есть то, на что жалуются: почта занята — значит человеку нужен
            вход, а не другая почта. */}
        {taken && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setMode('in');
              setTaken(false);
              setError(null);
            }}
          >
            {t('auth.toSignInFromError')}
          </button>
        )}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? t('common.loading') : mode === 'up' ? t('auth.signUp') : t('auth.signIn')}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setMode(mode === 'up' ? 'in' : 'up')}
        >
          {mode === 'up' ? t('auth.toSignIn') : t('auth.toSignUp')}
        </button>
      </form>
    </div>
  );
}
