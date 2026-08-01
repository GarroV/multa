import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { authClient } from '../lib/authClient.ts';
import { useI18n } from '../lib/i18n.tsx';
import { QrCode } from './ui/QrCode.tsx';

/**
 * Включение и выключение двухфакторки (issue #19).
 *
 * Порядок жёсткий и повторяет то, как работает better-auth: пароль → секрет и резервные коды →
 * **подтверждение кодом из приложения** → только теперь 2FA включена. Без последнего шага человек
 * рискует запереть себя снаружи: секрет создан, а приложение его не приняло — и выяснится это на
 * следующем входе.
 *
 * Резервные коды показываются ровно один раз, и об этом сказано прямо: сервер хранит их
 * зашифрованными и повторно показать не сможет.
 */

interface Enrollment {
  totpURI: string;
  backupCodes: string[];
}

/** Секрет из otpauth-ссылки — для тех, кто вводит его руками, без камеры. */
function secretOf(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

export function TwoFactor({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();

  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? t('common.error'));
      return;
    }
    setPassword('');
    setEnrollment({ totpURI: res.data.totpURI, backupCodes: res.data.backupCodes });
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? t('twofa.badCode'));
      return;
    }
    setCode('');
    setEnrollment(null);
    setOpen(false);
    await qc.invalidateQueries({ queryKey: ['me'] });
  };

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? t('common.error'));
      return;
    }
    setPassword('');
    setOpen(false);
    await qc.invalidateQueries({ queryKey: ['me'] });
  };

  return (
    <>
      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('twofa.title')}</span>
        </span>
        <span className="prow-num">
          <i className={enabled ? 'st-ok' : undefined}>{t(enabled ? 'twofa.on' : 'twofa.off')}</i>
        </span>
        <button type="button" className="act" onClick={() => setOpen((v) => !v)}>
          {t(open ? 'common.cancel' : enabled ? 'twofa.disable' : 'twofa.enable')}
        </button>
      </div>

      {open && !enrollment && (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <input
              className="field grow"
              type="password"
              autoComplete="current-password"
              placeholder={t('auth.password')}
              aria-label={t('auth.password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </span>
          <span className="prow-num" />
          <button
            type="button"
            className="act"
            disabled={busy || password.length === 0}
            onClick={() => void (enabled ? turnOff() : start())}
          >
            {busy ? t('common.loading') : t(enabled ? 'twofa.disable' : 'twofa.next')}
          </button>
          <span className="prow-note">
            {t(enabled ? 'twofa.disableHint' : 'twofa.passwordHint')}
          </span>
        </div>
      )}

      {enrollment && (
        <>
          <div className="prow twofa-enroll">
            <span className="prow-day" aria-hidden />
            <span className="prow-name">
              <QrCode value={enrollment.totpURI} />
            </span>
            <span className="prow-num" />
            <span />
            <span className="prow-note">
              {t('twofa.secret')} <code className="mono">{secretOf(enrollment.totpURI)}</code>
            </span>
          </div>

          <div className="prow">
            <span className="prow-day" aria-hidden />
            <span className="prow-name">
              <span className="st-warn">{t('twofa.backupOnce')}</span>
            </span>
            <span className="prow-num" />
            <span />
            <span className="prow-note mono">{enrollment.backupCodes.join('  ')}</span>
          </div>

          <div className="prow">
            <span className="prow-day" aria-hidden />
            <span className="prow-name">
              <input
                className="field num"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                aria-label={t('twofa.code')}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </span>
            <span className="prow-num" />
            <button
              type="button"
              className="act"
              disabled={busy || code.length < 6}
              onClick={() => void confirm()}
            >
              {busy ? t('common.loading') : t('twofa.confirm')}
            </button>
            {/* Пока код не подтверждён, 2FA не включена: об этом надо сказать, а не намекнуть. */}
            <span className="prow-note">{t('twofa.confirmHint')}</span>
          </div>
        </>
      )}

      {error && (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="danger">{error}</span>
          </span>
          <span className="prow-num" />
          <span />
        </div>
      )}
    </>
  );
}
