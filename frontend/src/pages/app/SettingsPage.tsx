import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HelpCircle,
  X,
  FolderGit2,
  ShieldCheck,
  Link2,
  PenLine,
  Sparkles,
  Download,
  AlertTriangle,
  Bookmark,
} from 'lucide-react';
import type { Profile, ProfileInput } from '@app/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';

// Source of truth for scoring: either the saved rich text ("Enter directly")
// or a public raw URL the worker fetches at analysis time ("Bring your own").
type SourceMode = 'direct' | 'url';

interface FormState {
  about: string;
  highInterests: string;
  mediumInterests: string;
  currentlyResearching: string;
  activeContexts: string;
  alreadyKnown: string;
  avoidContentTypes: string;
  profileSourceUrl: string;
  profileRepoUrl: string;
  githubToken: string;
}

// Shape returned by POST /profile/import (one LLM call → editable draft).
interface DraftProfile {
  highInterests: string[];
  mediumInterests: string[];
  currentlyResearching: string[];
  alreadyKnown: string[];
  activeContexts: string[];
  avoidContentTypes: string[];
  context: string;
}

const EMPTY_FORM: FormState = {
  about: '',
  highInterests: '',
  mediumInterests: '',
  currentlyResearching: '',
  activeContexts: '',
  alreadyKnown: '',
  avoidContentTypes: '',
  profileSourceUrl: '',
  profileRepoUrl: '',
  githubToken: '',
};

// A NEUTRAL, generic example profile for new accounts — a full-stack developer
// interested in AI and cloud. Deliberately NOT any specific person's profile,
// so it teaches the expected shape and granularity without biasing scoring
// toward one vendor or domain. Loaded (editable) by "Fill with an example".
const EXAMPLE_FORM: FormState = {
  about:
    'I’m a full-stack developer with a few years of experience, comfortable across ' +
    'frontend and backend. I’m growing into cloud and AI, and I want recommendations ' +
    'that push me forward: new capabilities, patterns and trade-offs I haven’t seen, ' +
    'not introductions to things I already use daily. Skip beginner tutorials and ' +
    'marketing pieces; favour concrete, technical material I can apply at work.',
  highInterests: ['Cloud architecture', 'Applied AI / LLMs', 'Web performance'].join('\n'),
  mediumInterests: ['Databases', 'DevOps and CI/CD', 'Observability'].join('\n'),
  currentlyResearching: ['Retrieval-augmented generation', 'Edge computing'].join('\n'),
  activeContexts: ['Building a side project', 'Migrating a service to the cloud'].join('\n'),
  alreadyKnown: ['REST APIs', 'SQL basics', 'Git workflows'].join('\n'),
  avoidContentTypes: ['Marketing listicles', 'Vendor sales webinars'].join('\n'),
  profileSourceUrl: '',
  profileRepoUrl: '',
  githubToken: '',
};

// Profile limits — mirror the Zod schema in @app/shared (schemas.ts):
// list fields allow up to 50 entries of 200 chars; the About free text up to
// 2000 chars. Surfaced in the UI as live "used/limit" counters, and enforced
// as hard `maxLength` on the inputs so the user can never exceed them.
const MAX_LIST_ENTRIES = 50;
const MAX_ENTRY_CHARS = 200;
const MAX_ABOUT_CHARS = 2000;

const toLines = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const fromLines = (arr: string[] | undefined): string => (arr ?? []).join('\n');

function profileToForm(profile: Profile): FormState {
  return {
    about: profile.context ?? '',
    highInterests: fromLines(profile.highInterests),
    mediumInterests: fromLines(profile.mediumInterests),
    currentlyResearching: fromLines(profile.currentlyResearching),
    activeContexts: fromLines(profile.activeContexts),
    alreadyKnown: fromLines(profile.alreadyKnown),
    avoidContentTypes: fromLines(profile.avoidContentTypes),
    profileSourceUrl: profile.profileSourceUrl ?? '',
    profileRepoUrl: profile.profileRepoUrl ?? '',
    githubToken: '', // write-only — never prefilled from the server
  };
}

function formToPayload(
  form: FormState,
  mode: SourceMode,
  tokenAction: 'set' | 'clear' | 'leave'
): ProfileInput {
  return {
    highInterests: toLines(form.highInterests),
    mediumInterests: toLines(form.mediumInterests),
    currentlyResearching: toLines(form.currentlyResearching),
    activeContexts: toLines(form.activeContexts),
    alreadyKnown: toLines(form.alreadyKnown),
    avoidContentTypes: toLines(form.avoidContentTypes),
    context: form.about.trim() ? form.about.trim() : undefined,
    profileSourceUrl: mode === 'url' ? form.profileSourceUrl.trim() : '',
    profileRepoUrl: mode === 'url' ? form.profileRepoUrl.trim() : '',
    // Token: 'set' sends the typed value, 'clear' sends '' to delete it,
    // 'leave' omits it so an existing stored token is untouched.
    githubToken:
      tokenAction === 'set' ? form.githubToken.trim() : tokenAction === 'clear' ? '' : undefined,
  };
}

export default function SettingsPage() {
  useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [mode, setMode] = useState<SourceMode>('direct');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // Whether a private-repo token is already stored (server flag, value never sent).
  const [hasToken, setHasToken] = useState(false);
  // User pressed "Remove token": send an explicit clear on next save.
  const [clearToken, setClearToken] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const profile = await api.get<Profile>('/profile');
      setForm(profileToForm(profile));
      setMode(profile.profileSourceUrl || profile.profileRepoUrl ? 'url' : 'direct');
      setNotConfigured(Boolean(profile.notConfigured));
      setHasToken(Boolean(profile.hasToken));
      setClearToken(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const touched = () => setSaved(false);

  // "Fill with an example": load the neutral example into the form (direct
  // mode) so a new user sees the expected shape and can edit or clear it. It
  // does NOT save — the user still reviews and presses "Create profile".
  const fillWithExample = () => {
    setForm(EXAMPLE_FORM);
    setMode('direct');
    touched();
  };

  // Whether the knowledge profile is effectively empty (nothing typed in any
  // field). Used to offer the example on an empty profile, not just first login.
  const isEmpty = (f: FormState): boolean =>
    !f.about.trim() &&
    !toLines(f.highInterests).length &&
    !toLines(f.mediumInterests).length &&
    !toLines(f.currentlyResearching).length &&
    !toLines(f.activeContexts).length &&
    !toLines(f.alreadyKnown).length &&
    !toLines(f.avoidContentTypes).length &&
    !f.profileSourceUrl.trim();

  // Prefill the form from an imported DRAFT (from "Import from URL"). The draft
  // is NEVER saved automatically — it lands in the editable form for review.
  const applyDraft = (draft: DraftProfile) => {
    setForm({
      about: draft.context ?? '',
      highInterests: fromLines(draft.highInterests),
      mediumInterests: fromLines(draft.mediumInterests),
      currentlyResearching: fromLines(draft.currentlyResearching),
      activeContexts: fromLines(draft.activeContexts),
      alreadyKnown: fromLines(draft.alreadyKnown),
      avoidContentTypes: fromLines(draft.avoidContentTypes),
      profileSourceUrl: '',
      profileRepoUrl: '',
      githubToken: '',
    });
    setMode('direct');
    setShowImport(false);
    touched();
  };

  const set =
    (key: keyof FormState) => (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      const { value } = e.target;
      setForm((prev) => ({ ...prev, [key]: value }));
      touched();
    };

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    const wasFirstSave = notConfigured;
    // Decide what to do with the token: clear if the user asked to remove it,
    // set if they typed a new one, otherwise leave any stored token untouched.
    const tokenAction: 'set' | 'clear' | 'leave' = clearToken
      ? 'clear'
      : form.githubToken.trim()
        ? 'set'
        : 'leave';
    try {
      const updated = await api.put<Profile>('/profile', formToPayload(form, mode, tokenAction));
      setForm(profileToForm(updated));
      setMode(updated.profileSourceUrl || updated.profileRepoUrl ? 'url' : 'direct');
      setNotConfigured(false);
      setHasToken(Boolean(updated.hasToken));
      setClearToken(false);
      setSaved(true);
      if (wasFirstSave) navigate('/app/library');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500">
            Your knowledge profile and data sources. This is how we decide what deserves your
            attention.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowHelp(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          <HelpCircle className="h-4 w-4" /> How does this work?
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <>
          {notConfigured && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-800">
              <p>
                Welcome! Set up your profile to unlock your library. Write a few lines about
                yourself and what matters to you, then save.
              </p>
              <button
                type="button"
                onClick={fillWithExample}
                className="mt-3 inline-flex items-center gap-1.5 rounded border border-indigo-300 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
              >
                <Sparkles className="h-4 w-4" /> Fill with an example
              </button>
            </div>
          )}

          {/* Empty profile that is NOT first-login: still offer the example. */}
          {!notConfigured && isEmpty(form) && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
              <span>Your profile is empty. Start from a neutral example and edit it.</span>
              <button
                type="button"
                onClick={fillWithExample}
                className="inline-flex shrink-0 items-center gap-1.5 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
              >
                <Sparkles className="h-4 w-4" /> Fill with an example
              </button>
            </div>
          )}

          <BookmarkletCard />

          <SourceToggle
            mode={mode}
            onChange={(m) => {
              setMode(m);
              touched();
            }}
          />

          {/* Import from URL / pasted text → editable draft (never saved blind). */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/40 p-3">
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Download className="h-4 w-4 text-indigo-600" />
              <span>
                Have a bio, CV or “about me” page? Import it to generate a draft you can edit.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded border border-indigo-300 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
            >
              Import from URL
            </button>
          </div>

          <form onSubmit={onSave} className="space-y-6">
            {mode === 'url' ? (
              <section className="space-y-1 rounded-lg border border-gray-200 bg-white p-4">
                <label htmlFor="sourceUrl" className="block text-sm font-semibold text-gray-800">
                  Public profile URL
                </label>
                <p className="text-xs text-gray-500">
                  A public raw URL to your own profile file (e.g. a <code>profile.md</code> in a
                  GitHub repo). We fetch it fresh each time we score, and we only store the URL —
                  never its contents.
                </p>
                <input
                  id="sourceUrl"
                  type="url"
                  className="input mt-1 w-full font-mono text-sm"
                  value={form.profileSourceUrl}
                  onChange={set('profileSourceUrl')}
                  placeholder="https://raw.githubusercontent.com/you/my-brain/main/profile.md"
                />
                <p className="mt-2 text-xs text-gray-400">
                  If the URL can’t be fetched at scoring time, we fall back to the text you saved
                  below.
                </p>

                {/* Private repo: URL + token stored in AWS Secrets Manager. */}
                <div className="mt-4 space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    Private repo (optional)
                    {hasToken && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        token stored
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    Point us at a <strong>private</strong> repo’s raw file and give a fine-grained,
                    read-only token. We fetch the file with the token at scoring time; the token is
                    stored encrypted in AWS Secrets Manager and never shown again. The public URL
                    above takes priority if both are set.
                  </p>
                  <input
                    type="url"
                    className="input mt-1 w-full font-mono text-sm"
                    value={form.profileRepoUrl}
                    onChange={set('profileRepoUrl')}
                    placeholder="https://raw.githubusercontent.com/you/private-brain/main/profile.md"
                  />
                  <input
                    type="password"
                    autoComplete="off"
                    className="input w-full font-mono text-sm"
                    value={form.githubToken}
                    onChange={set('githubToken')}
                    placeholder={
                      hasToken ? '•••••••• (leave blank to keep current token)' : 'github_pat_...'
                    }
                  />
                  {hasToken && (
                    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        checked={clearToken}
                        onChange={(e) => {
                          setClearToken(e.target.checked);
                          touched();
                        }}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-red-600 focus:ring-red-500"
                      />
                      Remove the stored token on save
                    </label>
                  )}
                  <p className="text-xs text-gray-400">
                    Create it at GitHub → Settings → Developer settings → Fine-grained tokens,
                    scoped to <strong>one repository</strong> with{' '}
                    <strong>Contents: Read-only</strong>.
                  </p>
                </div>
              </section>
            ) : null}

            <div className={mode === 'url' ? 'opacity-60' : ''}>
              <Field
                id="about"
                label="About you — the main signal"
                primary
                hint={
                  'Tell us your background, your level, how you work, and how you want ' +
                  'recommendations judged, in full sentences. Don’t repeat your interest lists ' +
                  'above; this is your context and criteria. You can write this in your own ' +
                  'language, it works just as well.'
                }
                value={form.about}
                onChange={set('about')}
                rows={6}
                counter="chars"
                maxLength={MAX_ABOUT_CHARS}
                placeholder={
                  'e.g. I’m a senior cloud architect focused on AWS, serverless and platform engineering. ' +
                  'I want the small fraction of content that materially improves my work. ' +
                  'Skip fundamentals I already know; prioritize new capabilities, patterns, trade-offs and benchmarks.'
                }
              />

              <div className="mt-6 grid gap-6 md:grid-cols-2">
                <Field
                  id="high"
                  label="High interests"
                  hint="One per line."
                  value={form.highInterests}
                  onChange={set('highInterests')}
                  counter="list"
                />
                <Field
                  id="medium"
                  label="Medium interests"
                  hint="One per line."
                  value={form.mediumInterests}
                  onChange={set('mediumInterests')}
                  counter="list"
                />
                <Field
                  id="researching"
                  label="Currently researching"
                  hint="What you are actively investigating now. One per line."
                  value={form.currentlyResearching}
                  onChange={set('currentlyResearching')}
                  counter="list"
                />
                <Field
                  id="contexts"
                  label="Active contexts / projects"
                  hint="Initiatives you are building or driving (distinct from research). One per line."
                  value={form.activeContexts}
                  onChange={set('activeContexts')}
                  counter="list"
                />
                <Field
                  id="known"
                  label="Already known"
                  hint="Don’t re-explain fundamentals of these. One per line."
                  value={form.alreadyKnown}
                  onChange={set('alreadyKnown')}
                  counter="list"
                />
                <Field
                  id="avoid"
                  label="Avoid content types"
                  hint="Kinds of content you’d rather not see. One per line."
                  value={form.avoidContentTypes}
                  onChange={set('avoidContentTypes')}
                  counter="list"
                />
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
            {saved && <p className="text-sm text-green-600">Profile saved.</p>}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : notConfigured ? 'Create profile' : 'Save profile'}
              </button>
            </div>
          </form>
        </>
      )}

      {showHelp && <HowItWorksModal onClose={() => setShowHelp(false)} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onDraft={applyDraft} />}
    </div>
  );
}

interface FieldProps {
  id: string;
  label: string;
  hint: string | React.ReactNode;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  rows?: number;
  primary?: boolean;
  placeholder?: string;
  // Live usage counter under the field. 'list' counts non-empty lines against
  // MAX_LIST_ENTRIES; 'chars' counts characters against MAX_ABOUT_CHARS.
  counter?: 'list' | 'chars';
  // Hard character cap on the textarea (About field).
  maxLength?: number;
}

// "Near the limit" threshold: turn the counter red at ≥90% of the cap.
const NEAR_LIMIT_RATIO = 0.9;

function UsageCounter({ counter, value }: { counter: 'list' | 'chars'; value: string }) {
  if (counter === 'chars') {
    const used = value.length;
    const near = used >= MAX_ABOUT_CHARS * NEAR_LIMIT_RATIO;
    const over = used > MAX_ABOUT_CHARS;
    return (
      <p className={`mt-1 text-right text-xs ${over || near ? 'text-red-600' : 'text-gray-400'}`}>
        {used}/{MAX_ABOUT_CHARS}
      </p>
    );
  }
  const entries = value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const used = entries.length;
  const longEntries = entries.filter((e) => e.length > MAX_ENTRY_CHARS).length;
  const near = used >= MAX_LIST_ENTRIES * NEAR_LIMIT_RATIO;
  const over = used > MAX_LIST_ENTRIES;
  return (
    <p className={`mt-1 text-right text-xs ${over || near ? 'text-red-600' : 'text-gray-400'}`}>
      {used}/{MAX_LIST_ENTRIES}
      {longEntries > 0 && (
        <span className="text-red-600">
          {' '}
          · {longEntries} over {MAX_ENTRY_CHARS} chars
        </span>
      )}
    </p>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  rows = 4,
  primary,
  placeholder,
  counter,
  maxLength,
}: FieldProps) {
  return (
    <section
      className={
        primary ? 'space-y-1 rounded-lg border border-indigo-200 bg-indigo-50/50 p-4' : 'space-y-1'
      }
    >
      <label htmlFor={id} className="block text-sm font-semibold text-gray-800">
        {label}
      </label>
      <p className="text-xs text-gray-500">{hint}</p>
      <textarea
        id={id}
        className="input mt-1 min-h-24 w-full"
        rows={rows}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        maxLength={maxLength}
      />
      {counter && <UsageCounter counter={counter} value={value} />}
    </section>
  );
}

// Capture-link bookmarklet: a browser favourite whose "URL" is a snippet of JS.
// Pressing it on ANY page opens this app's Add Content with the current page's
// URL pre-filled. Works where PWA Share Target doesn't (Brave/Safari on iOS).
// The app's own origin is baked in at render so it points at wherever the app
// is served (custom domain or CloudFront).
function BookmarkletCard() {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const code =
    `javascript:(function(){` +
    `window.open('${origin}/app/add?url='+encodeURIComponent(location.href)+` +
    `'&title='+encodeURIComponent(document.title),'_blank');` +
    `})();`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied — the code is visible to copy manually.
    }
  };

  return (
    <section className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
        <Bookmark className="h-4 w-4 text-indigo-600" /> Capture links while you browse
      </h2>
      <p className="text-xs text-gray-500">
        Add this as a browser bookmark. On any page, tap it and the link lands here, ready to
        analyze — handy on mobile (Brave/Safari) where there’s no “share to app”.
      </p>

      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded border border-gray-200 bg-white px-2 py-1 font-mono text-xs text-gray-600">
          {code}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 rounded border border-indigo-300 bg-white px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>

      <details className="text-xs text-gray-500">
        <summary className="cursor-pointer font-medium text-gray-600">How to install it</summary>
        <div className="mt-2 space-y-2">
          <div>
            <p className="font-medium text-gray-700">Desktop (Chrome / Brave / Firefox)</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>Show the bookmarks bar (⌘/Ctrl+Shift+B).</li>
              <li>Right-click it → “Add page / New bookmark”.</li>
              <li>
                Name it “Save to Inbox”, paste the code above as the <strong>URL</strong>, save.
              </li>
              <li>On any page, click it — the link opens here pre-filled.</li>
            </ol>
          </div>
          <div>
            <p className="font-medium text-gray-700">iPhone (Brave / Safari)</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>Bookmark any page (the share icon → Add Bookmark).</li>
              <li>Open Bookmarks → Edit → tap that bookmark.</li>
              <li>Replace its address with the copied code, rename it “Save to Inbox”, done.</li>
              <li>While browsing, open it from your bookmarks to send the current page here.</li>
            </ol>
          </div>
        </div>
      </details>
    </section>
  );
}

function SourceToggle({ mode, onChange }: { mode: SourceMode; onChange: (m: SourceMode) => void }) {
  const Btn = ({
    m,
    icon,
    title,
    desc,
  }: {
    m: SourceMode;
    icon: React.ReactNode;
    title: string;
    desc: string;
  }) => (
    <button
      type="button"
      onClick={() => onChange(m)}
      className={`flex-1 rounded-lg border p-3 text-left transition ${
        mode === m
          ? 'border-indigo-600 bg-indigo-50 ring-1 ring-indigo-600'
          : 'border-gray-300 bg-white hover:bg-gray-50'
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-gray-800">
        {icon}
        {title}
      </span>
      <span className="mt-1 block text-xs text-gray-500">{desc}</span>
    </button>
  );
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Btn
        m="direct"
        icon={<PenLine className="h-4 w-4 text-indigo-600" />}
        title="Enter directly"
        desc="Write your profile here. Stored securely with your account."
      />
      <Btn
        m="url"
        icon={<Link2 className="h-4 w-4 text-indigo-600" />}
        title="Bring your own"
        desc="Point us at a profile file in a repo — public, or private with a read-only token."
      />
    </div>
  );
}

function HowItWorksModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto overflow-x-hidden break-words rounded-xl bg-white p-6 shadow-xl [overflow-wrap:anywhere]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="help-title" className="text-lg font-semibold text-gray-900">
            How your profile works
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-3 text-sm text-gray-600">
          We score each document by reading your whole profile and judging — semantically, not by
          keyword matching — whether it brings something new and relevant to <em>you</em>. There are
          two ways to give us that profile.
        </p>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-gray-200 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
              <PenLine className="h-4 w-4 text-indigo-600" /> Enter directly
            </h3>
            <p className="mt-1 text-xs font-medium text-gray-500">Pros</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-600">
              <li>Nothing to set up — just type and save.</li>
              <li>Edit any time from this page.</li>
            </ul>
            <p className="mt-2 text-xs font-medium text-gray-500">Cons</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-600">
              <li>Your profile text is stored in this app.</li>
              <li>You maintain it here, separate from your own notes.</li>
            </ul>
          </div>

          <div className="rounded-lg border border-gray-200 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
              <Link2 className="h-4 w-4 text-indigo-600" /> Bring your own
            </h3>
            <p className="mt-1 text-xs font-medium text-gray-500">Pros</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-600">
              <li>You own the data — we only store the URL.</li>
              <li>Keep one source of truth in your own repo.</li>
              <li>We fetch it fresh at scoring time, so edits apply instantly.</li>
            </ul>
            <p className="mt-2 text-xs font-medium text-gray-500">Cons</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-600">
              <li>The file must be reachable at a public raw URL.</li>
              <li>If it can’t be fetched, we fall back to your saved text.</li>
            </ul>
          </div>
        </div>

        <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
            <FolderGit2 className="h-4 w-4" /> Set up a <code>my-brain</code> repo
          </h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-600">
            <li>
              Create a repository (e.g. <code>my-brain</code>) with a <code>profile.md</code> file
              describing your interests and background.
            </li>
            <li>
              Use the <strong>raw</strong> file URL, for example{' '}
              <code>https://raw.githubusercontent.com/&lt;you&gt;/my-brain/main/profile.md</code>.
            </li>
            <li>Paste that URL into “Bring your own”, then save.</li>
          </ol>
        </div>

        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
            <ShieldCheck className="h-4 w-4" /> Private repo? Read-only access only
          </h3>
          <p className="mt-1 text-sm text-emerald-900">
            Today we only support <strong>public</strong> raw URLs. Authenticated access to a{' '}
            <em>private</em> repo (via a token you paste and can revoke) is coming next. When it
            arrives, the safe way to grant it will be a GitHub{' '}
            <strong>fine-grained personal access token</strong> scoped to{' '}
            <strong>a single repository</strong> with <strong>Contents: Read-only</strong> and
            nothing else — never a classic token or broad scopes.
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-emerald-900">
            <li>
              GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
            </li>
            <li>
              Resource owner: you. Repository access: “Only select repositories” → your{' '}
              <code>my-brain</code>.
            </li>
            <li>
              Permissions → Repository permissions → <strong>Contents: Read-only</strong>. Leave
              everything else as No access.
            </li>
            <li>Set a short expiration and keep the token secret.</li>
          </ol>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

// Import a profile from a public URL OR pasted text. Calls POST /profile/import,
// which fetches/reads the text and asks the model for a DRAFT profile; the draft
// is handed back via onDraft to prefill the editable form (never saved blind).
function ImportModal({
  onClose,
  onDraft,
}: {
  onClose: () => void;
  onDraft: (draft: DraftProfile) => void;
}) {
  const [tab, setTab] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    setError('');
    const payload = tab === 'url' ? { url: url.trim() } : { text: text.trim() };
    if (tab === 'url' && !payload.url) return setError('Enter a public URL.');
    if (tab === 'text' && !payload.text) return setError('Paste some text.');
    setLoading(true);
    try {
      const res = await api.post<{ draft: DraftProfile }>('/profile/import', payload);
      onDraft(res.draft);
    } catch (err) {
      setError((err as Error).message || 'Could not import. Try pasting the text instead.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-title"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="import-title" className="text-lg font-semibold text-gray-900">
            Import a profile
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-2 text-sm text-gray-600">
          We’ll read the content and generate a <strong>draft</strong> profile. Nothing is saved —
          you review and edit it first.
        </p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setTab('url')}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
              tab === 'url'
                ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            From a URL
          </button>
          <button
            type="button"
            onClick={() => setTab('text')}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
              tab === 'text'
                ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Paste text
          </button>
        </div>

        {tab === 'url' ? (
          <div className="mt-4 space-y-2">
            <input
              type="url"
              className="input w-full font-mono text-sm"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/you/about or a personal site"
            />
            <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                GitHub profiles and public personal sites work well.{' '}
                <strong>LinkedIn blocks automated access</strong>, so a LinkedIn URL will fail —
                paste the text directly instead.
              </span>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <textarea
              className="input min-h-40 w-full"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste a bio, CV, or any text about yourself…"
            />
          </div>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-2 text-sm font-medium text-gray-500 hover:text-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={loading}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Generating draft…' : 'Generate draft'}
          </button>
        </div>
      </div>
    </div>
  );
}
