import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  signIn,
  signOut,
  confirmSignIn,
  resetPassword,
  confirmResetPassword,
  type SignInOutput,
} from 'aws-amplify/auth';
import { useAuth } from '../../context/AuthContext';

type Step = 'CREDENTIALS' | 'NEW_PASSWORD' | 'RESET_PASSWORD';

interface LoginNavState {
  email?: string;
  notice?: string;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const navState = (location.state as LoginNavState | null) ?? null;
  const { refresh } = useAuth();
  const [step, setStep] = useState<Step>('CREDENTIALS');
  const [email, setEmail] = useState(navState?.email ?? '');
  const [notice] = useState(navState?.notice ?? '');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetDestination, setResetDestination] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const advance = async (result: SignInOutput) => {
    const next = result.nextStep?.signInStep;
    switch (next) {
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
        setStep('NEW_PASSWORD');
        return;
      case 'RESET_PASSWORD': {
        const out = await resetPassword({ username: email });
        if (out.nextStep.resetPasswordStep === 'CONFIRM_RESET_PASSWORD_WITH_CODE') {
          setResetDestination(out.nextStep.codeDeliveryDetails.destination ?? '');
        }
        setStep('RESET_PASSWORD');
        return;
      }
      case 'DONE':
        await refresh();
        navigate('/app');
        return;
      default:
        setError(`Unsupported login step: ${next}`);
    }
  };

  const onCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    // Browser autofill fills the DOM inputs without firing React onChange, so
    // read straight from the form to avoid a stale-empty email/password.
    const form = e.currentTarget as HTMLFormElement;
    const emailValue = (
      (form.elements.namedItem('email') as HTMLInputElement | null)?.value ?? email
    ).trim();
    const passwordValue =
      (form.elements.namedItem('password') as HTMLInputElement | null)?.value ?? password;
    if (emailValue && emailValue !== email) setEmail(emailValue);
    if (!emailValue || !passwordValue) {
      setError('Enter your email and password.');
      return;
    }
    setLoading(true);
    try {
      // signOut before signIn: avoids UserAlreadyAuthenticatedException if a session lingered.
      try {
        await signOut();
      } catch {
        /* no previous session */
      }
      const result = await signIn({ username: emailValue, password: passwordValue });
      await advance(result);
    } catch (err) {
      setError((err as Error).message || 'Sign-in error');
    } finally {
      setLoading(false);
    }
  };

  const onNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await confirmSignIn({ challengeResponse: newPassword });
      await advance(result);
    } catch (err) {
      setError((err as Error).message || 'Error changing the password');
    } finally {
      setLoading(false);
    }
  };

  const onResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await confirmResetPassword({ username: email, confirmationCode: resetCode, newPassword });
      const result = await signIn({ username: email, password: newPassword });
      await advance(result);
    } catch (err) {
      setError((err as Error).message || 'Error resetting the password');
    } finally {
      setLoading(false);
    }
  };

  // Explicit "forgot password" entry: trigger the reset flow directly instead
  // of waiting for Cognito to return a RESET_PASSWORD challenge on sign-in.
  const onForgotPassword = async () => {
    setError('');
    if (!email.trim()) {
      setError('Enter your email first, then tap “Forgot your password?”.');
      return;
    }
    setLoading(true);
    try {
      const out = await resetPassword({ username: email });
      if (out.nextStep.resetPasswordStep === 'CONFIRM_RESET_PASSWORD_WITH_CODE') {
        setResetDestination(out.nextStep.codeDeliveryDetails.destination ?? '');
      }
      setStep('RESET_PASSWORD');
    } catch (err) {
      setError((err as Error).message || 'Could not start the password reset');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gray-50 px-4 py-12 safe-pt safe-pb">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm sm:p-10">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/logo.svg" alt="" className="h-14 w-14" />
          <h1 className="mt-4 text-2xl font-semibold text-gray-900">Knowledge Inbox Zero</h1>
          <p className="mt-1 text-sm text-gray-500">Welcome back — sign in to continue</p>
        </div>

        {notice && (
          <div className="mb-5 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800">
            {notice}
          </div>
        )}

        {step === 'CREDENTIALS' && (
          <form onSubmit={onCredentials} className="space-y-5">
            <Field label="Email">
              <input
                type="email"
                name="email"
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
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                required
                autoComplete="current-password"
              />
            </Field>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void onForgotPassword()}
                disabled={loading}
                className="text-sm font-medium text-indigo-600 hover:underline disabled:opacity-50"
              >
                Forgot your password?
              </button>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <SubmitBtn loading={loading}>Sign in</SubmitBtn>
            <p className="text-center text-sm text-gray-500">
              No account yet?{' '}
              <Link to="/signup" className="font-medium text-indigo-600 hover:underline">
                Sign up
              </Link>
            </p>
          </form>
        )}

        {step === 'NEW_PASSWORD' && (
          <form onSubmit={onNewPassword} className="space-y-4">
            <p className="text-sm text-gray-600">
              Set a new password (at least 12 characters, with uppercase, lowercase, digits and
              symbols).
            </p>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input"
              placeholder="New password"
              required
              autoComplete="new-password"
              autoFocus
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <SubmitBtn loading={loading}>Change password</SubmitBtn>
          </form>
        )}

        {step === 'RESET_PASSWORD' && (
          <form onSubmit={onResetPassword} className="space-y-4">
            <p className="text-sm text-gray-600">
              Enter the code sent{resetDestination ? ` to ${resetDestination}` : ' to your email'}{' '}
              and your new password.
            </p>
            <Field label="Verification code">
              <input
                value={resetCode}
                onChange={(e) => setResetCode(e.target.value.replace(/\s/g, ''))}
                className="input text-center text-lg tracking-widest"
                inputMode="numeric"
                required
                autoFocus
              />
            </Field>
            <Field label="New password">
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="input"
                required
                autoComplete="new-password"
              />
            </Field>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <SubmitBtn loading={loading}>Reset and sign in</SubmitBtn>
          </form>
        )}

        <p className="mt-8 border-t border-gray-100 pt-5 text-center text-sm">
          <Link to="/" className="font-medium text-gray-500 hover:text-indigo-600 hover:underline">
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
