import { useState } from 'react';
import { Link } from 'react-router-dom';
import { updatePassword } from 'aws-amplify/auth';
import { KeyRound, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

// "My account": identity + password. The knowledge profile and data sources
// live on their own page (Settings) so account management is not mixed with
// configuration.
export default function ProfilePage() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">My account</h1>
        <p className="text-sm text-gray-500">Your identity and sign-in.</p>
      </div>

      <dl className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
        <div className="flex justify-between py-1">
          <dt className="text-gray-500">Email</dt>
          <dd className="text-gray-900">{user?.email}</dd>
        </div>
        <div className="flex justify-between py-1">
          <dt className="text-gray-500">Role</dt>
          <dd className="text-gray-900">{user?.role}</dd>
        </div>
        <div className="flex justify-between py-1">
          <dt className="text-gray-500">ID</dt>
          <dd className="font-mono text-xs text-gray-500">{user?.sub}</dd>
        </div>
      </dl>

      <ChangePasswordSection />

      {/* Pointer to where the knowledge profile now lives. */}
      <Link
        to="/app/settings"
        className="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-700"
      >
        <SlidersHorizontal className="h-4 w-4" />
        Edit your knowledge profile &amp; data sources in Settings →
      </Link>

      <p className="text-xs text-gray-400">Version {__APP_VERSION__}</p>
    </div>
  );
}

// Password rules mirrored from the Cognito pool policy (≥12, upper/lower/digit/symbol).
function validatePassword(pw: string): string | null {
  if (pw.length < 12) return 'Use at least 12 characters.';
  if (!/[A-Z]/.test(pw)) return 'Include an uppercase letter.';
  if (!/[a-z]/.test(pw)) return 'Include a lowercase letter.';
  if (!/\d/.test(pw)) return 'Include a digit.';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Include a symbol.';
  return null;
}

// "Change password" for the signed-in user, backed by Amplify updatePassword
// (requires the current password). No federated-user guard is needed here —
// this app has no SSO/IdP users.
function ChangePasswordSection() {
  const [open, setOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const reset = () => {
    setOldPassword('');
    setNewPassword('');
    setConfirm('');
    setError('');
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword !== confirm) {
      setError('The new password and its confirmation do not match.');
      return;
    }
    const ruleError = validatePassword(newPassword);
    if (ruleError) {
      setError(ruleError);
      return;
    }
    if (newPassword === oldPassword) {
      setError('The new password must be different from the current one.');
      return;
    }
    setSaving(true);
    try {
      await updatePassword({ oldPassword, newPassword });
      setSuccess('Password updated.');
      reset();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message || 'Could not update your password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-800">Change password</h2>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => {
              reset();
              setSuccess('');
              setOpen(true);
            }}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Change
          </button>
        )}
      </div>

      {success && !open && <p className="mt-2 text-sm text-green-600">{success}</p>}

      {open && (
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">Current password</span>
            <input
              type="password"
              className="input w-full"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">New password</span>
            <input
              type="password"
              className="input w-full"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Confirm new password
            </span>
            <input
              type="password"
              className="input w-full"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
          </label>
          <p className="text-xs text-gray-400">
            At least 12 characters, with uppercase, lowercase, a digit and a symbol.
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Updating…' : 'Update password'}
            </button>
            <button
              type="button"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              className="rounded px-3 py-2 text-sm font-medium text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
