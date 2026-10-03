import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signUp, confirmSignUp, signIn, signOut } from 'aws-amplify/auth';
import { useAuth } from '../../context/AuthContext';

type Step = 'FORM' | 'CONFIRM';

// Password policy mirrors the Cognito user pool (verified via describe-user-pool):
// min 12 chars, upper + lower + digit + symbol.
const PASSWORD_RULE = 'At least 12 characters, with uppercase, lowercase, a digit and a symbol.';

export default function SignUpPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [step, setStep] = useState<Step>('FORM');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  const onSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      try {
        await signOut();
      } catch {
        /* no previous session */
      }
      const out = await signUp({
        username: email,
        password,
        options: { userAttributes: { email } },
      });
      if (out.nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
        setInfo(`We sent a verification code to ${email}.`);
        setStep('CONFIRM');
      } else if (out.nextStep.signUpStep === 'DONE') {
        await finishSignIn();
      }
    } catch (err) {
      setError((err as Error).message || 'Sign-up error');
    } finally {
      setLoading(false);
    }
  };

  const onConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await confirmSignUp({ username: email, confirmationCode: code });
      await finishSignIn();
    } catch (err) {
      setError((err as Error).message || 'Confirmation error');
    } finally {
      setLoading(false);
    }
  };

  // Sign in right after confirmation. If sign-in returns DONE we go straight to
  // the app; otherwise (e.g. a NEW_PASSWORD challenge) we hand off to the login
  // page, which drives the remaining steps.
  const finishSignIn = async () => {
    try {
      const result = await signIn({ username: email, password });
      if (result.nextStep?.signInStep === 'DONE') {
        await refresh();
        navigate('/app', { replace: true });
        return;
      }
      navigate('/login', {
        replace: true,
        state: { email, notice: 'Account created. Sign in to finish setup.' },
      });
    } catch {
      // Account exists; let the user sign in manually.
      navigate('/login', {
        replace: true,
        state: { email, notice: 'Account created. Please sign in.' },
      });
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gray-50 px-4 py-8 safe-pt safe-pb">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-1 flex items-center gap-3">
          <img src="/logo.svg" alt="" className="h-10 w-10" />
          <h1 className="text-2xl font-semibold text-gray-900">Create your account</h1>
        </div>
        <p className="mb-6 text-sm text-gray-500">Knowledge Inbox Zero</p>

        {step === 'FORM' && (
          <form onSubmit={onSignUp} className="space-y-4">
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                required
                autoComplete="email"
                autoFocus
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                required
                autoComplete="new-password"
                minLength={12}
              />
              <span className="mt-1 block text-xs text-gray-500">{PASSWORD_RULE}</span>
            </Field>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <SubmitBtn loading={loading}>Sign up</SubmitBtn>
          </form>
        )}

        {step === 'CONFIRM' && (
          <form onSubmit={onConfirm} className="space-y-4">
            {info && <p className="text-sm text-gray-600">{info}</p>}
            <Field label="Verification code">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))}
                className="input text-center text-lg tracking-widest"
                inputMode="numeric"
                required
                autoFocus
              />
            </Field>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <SubmitBtn loading={loading}>Confirm and continue</SubmitBtn>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-gray-500">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-indigo-600 hover:underline">
            Sign in
          </Link>
        </p>
        <p className="mt-2 text-center text-sm">
          <Link to="/" className="text-gray-400 hover:text-gray-600 hover:underline">
            ← Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}

function SubmitBtn({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full rounded bg-indigo-600 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
    >
      {loading ? 'Working…' : children}
    </button>
  );
}
