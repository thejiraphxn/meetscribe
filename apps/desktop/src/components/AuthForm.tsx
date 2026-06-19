import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';

type Mode = 'signin' | 'signup';

/** Email/password authentication form (no Google required). */
export function AuthForm(): React.ReactElement {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signup') {
        await signUp(email.trim(), password, name.trim() || undefined);
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="w-72 flex flex-col gap-3 p-5 rounded-xl bg-surface-elevated border border-border"
    >
      <h2 className="text-base font-semibold text-text-primary">
        {mode === 'signup' ? 'Create your account' : 'Welcome back'}
      </h2>

      {mode === 'signup' && (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
          className="text-sm bg-surface border border-border rounded px-3 py-2
                     text-text-primary outline-none focus:border-accent-amber"
        />
      )}

      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        autoComplete="email"
        className="text-sm bg-surface border border-border rounded px-3 py-2
                   text-text-primary outline-none focus:border-accent-amber"
      />

      <input
        type="password"
        required
        minLength={mode === 'signup' ? 8 : undefined}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={mode === 'signup' ? 'Password (min 8 chars)' : 'Password'}
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        className="text-sm bg-surface border border-border rounded px-3 py-2
                   text-text-primary outline-none focus:border-accent-amber"
      />

      {error && <p className="text-xs text-accent-red">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="text-sm px-4 py-2 rounded-md bg-accent-amber text-black font-semibold
                   disabled:opacity-50"
      >
        {busy ? '…' : mode === 'signup' ? 'Sign up' : 'Sign in'}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode((m) => (m === 'signup' ? 'signin' : 'signup'));
          setError(null);
        }}
        className="text-xs text-text-muted hover:text-text-primary"
      >
        {mode === 'signup'
          ? 'Already have an account? Sign in'
          : "No account? Create one"}
      </button>
    </form>
  );
}
