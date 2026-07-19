import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { authClient } from '../lib/authClient.ts';
import { useI18n } from '../lib/i18n.tsx';

export function Login() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'in' | 'up'>('up');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === 'up'
        ? await authClient.signUp.email({ email, password, name })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? 'error');
      return;
    }
    await qc.invalidateQueries({ queryKey: ['me'] });
  }

  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
      <form onSubmit={submit} className="card" style={{ width: 'min(420px, 100%)', display: 'grid', gap: 14 }}>
        <div>
          <div className="brand" style={{ fontSize: 28, fontWeight: 600 }}>
            {t('auth.title')}
          </div>
          <div className="dim" style={{ marginTop: 4 }}>
            {t('auth.subtitle')}
          </div>
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
        {error && (
          <div className="danger" style={{ fontSize: 14 }}>
            {error}
          </div>
        )}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? t('common.loading') : mode === 'up' ? t('auth.signUp') : t('auth.signIn')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setMode(mode === 'up' ? 'in' : 'up')}>
          {mode === 'up' ? t('auth.toSignIn') : t('auth.toSignUp')}
        </button>
      </form>
    </div>
  );
}
