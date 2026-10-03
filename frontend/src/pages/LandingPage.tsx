import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Target, Gauge, UserCog, ArrowRight, Clock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import PageLoader from '../components/ui/PageLoader';

export default function LandingPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  // Already signed in → send straight to the app.
  useEffect(() => {
    if (!loading && user) navigate('/app', { replace: true });
  }, [loading, user, navigate]);

  if (loading) return <PageLoader />;

  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5">
        <div className="flex items-center gap-2 font-semibold">
          <img src="/logo.svg" alt="" className="h-7 w-7" />
          Knowledge Inbox Zero
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link to="/login" className="text-gray-600 hover:text-gray-900">
            Sign in
          </Link>
          <Link
            to="/signup"
            className="rounded bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700"
          >
            Sign up
          </Link>
        </div>
      </header>

      <main>
        {/* Hero: name the pain first, then the fix. */}
        <section className="mx-auto max-w-3xl px-4 pb-10 pt-12 text-center sm:pt-20">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
            You save hundreds of links.
            <br className="hidden sm:block" /> You read almost none of them.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-gray-600">
            Knowledge Inbox Zero scores every link against what you already know and what you
            actually care about, then tells you whether it&apos;s worth reading, skimming, or
            skipping. You read only what adds something — the rest stops weighing on you.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link
              to="/signup"
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-700"
            >
              Get started free <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/login"
              className="rounded-lg border border-gray-300 px-5 py-3 font-medium text-gray-700 hover:bg-gray-50"
            >
              Sign in
            </Link>
          </div>
        </section>

        {/* Live demo: what the output actually looks like, inside a browser
            frame. Rendered in CSS so it stays crisp and never goes stale (no
            screenshot to maintain, no personal data on a public page). */}
        <section className="mx-auto max-w-3xl px-4 pb-16">
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl shadow-indigo-100/50">
            {/* Browser chrome */}
            <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-100 px-4 py-2.5">
              <span className="h-3 w-3 rounded-full bg-red-400" />
              <span className="h-3 w-3 rounded-full bg-yellow-400" />
              <span className="h-3 w-3 rounded-full bg-green-400" />
              <span className="ml-3 flex-1 truncate rounded-md bg-white px-3 py-1 text-xs text-gray-400 ring-1 ring-gray-200">
                inbox.playingaws.com/app/library
              </span>
            </div>

            {/* App viewport */}
            <div className="space-y-3 bg-gray-50 p-4 sm:p-6">
              {/* Attention saved — the headline metric, mirroring the real app. */}
              <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 sm:p-5">
                <p className="text-xs font-medium uppercase tracking-wide text-indigo-700">
                  Attention saved
                </p>
                <p className="mt-1 text-3xl font-bold text-indigo-900 sm:text-4xl">
                  23<span className="text-lg font-semibold text-indigo-500"> / 40</span>
                </p>
                <p className="mt-1 text-sm text-indigo-700">
                  You saved attention on 23 of 40 links (57%) that didn&apos;t deserve it.
                </p>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-indigo-100">
                  <div className="h-full rounded-full bg-indigo-500" style={{ width: '57%' }} />
                </div>
              </div>

              <p className="pt-1 text-xs font-medium uppercase tracking-wide text-gray-400">
                Your links, most valuable first
              </p>
              <div className="space-y-2">
                <DemoCard
                  title="Building event-driven architectures on AWS"
                  domain="aws.amazon.com"
                  verdict="worth"
                  reason="Directly matches your AWS architecture focus and covers EventBridge patterns you're researching."
                  minutes={12}
                  mkv={88}
                />
                <DemoCard
                  title="10 productivity hacks that changed my life"
                  domain="medium.com"
                  verdict="skip"
                  reason="Generic listicle — the kind of content you asked to avoid. Nothing new for you."
                  minutes={4}
                  mkv={9}
                />
                <DemoCard
                  title="A refresher on REST API design"
                  domain="blog.example.com"
                  verdict="maybe"
                  reason="Mostly fundamentals you already know, but the versioning section may be worth a skim."
                  minutes={7}
                  mkv={41}
                />
              </div>
            </div>
          </div>
          <p className="mt-3 text-center text-xs text-gray-400">
            Paste a messy pile of links — get a verdict on each.
          </p>
        </section>

        {/* Problem → solution, stated plainly. */}
        <section className="border-y border-gray-100 bg-gray-50">
          <div className="mx-auto grid max-w-4xl gap-8 px-4 py-14 sm:grid-cols-2">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-rose-600">
                The problem
              </h2>
              <p className="mt-2 text-lg text-gray-700">
                You pile up articles &ldquo;for later&rdquo; — bookmarks, open tabs, links from
                everywhere — and almost never open them again. The backlog only grows, and the good
                stuff is buried in noise.
              </p>
            </div>
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
                The solution
              </h2>
              <p className="mt-2 text-lg text-gray-700">
                An AI filter built on <em>your</em> profile separates what teaches you something new
                from what you already know or don&apos;t care about — so you spend your reading time
                only where it pays off.
              </p>
            </div>
          </div>
        </section>

        {/* Features reframed to the benefit, each with its own icon. */}
        <section className="mx-auto grid max-w-5xl gap-6 px-4 py-16 sm:grid-cols-3">
          <Feature
            icon={<Target className="h-6 w-6 text-indigo-600" />}
            title="Scored by what it adds to you"
            body="Not generic popularity — Marginal Knowledge Value weighs each link against what you already know and what you're researching."
          />
          <Feature
            icon={<Gauge className="h-6 w-6 text-indigo-600" />}
            title="Worth it, maybe, or skip"
            body="One clear verdict per link with a short reason, so you decide in seconds instead of hoarding tabs."
          />
          <Feature
            icon={<UserCog className="h-6 w-6 text-indigo-600" />}
            title="Tuned to your profile"
            body="Describe your interests and what you already master once; every score adapts to you from then on."
          />
        </section>

        {/* The metric that matters: attention saved, not content stored. */}
        <section className="bg-indigo-600">
          <div className="mx-auto max-w-3xl px-4 py-14 text-center text-white">
            <h2 className="text-2xl font-semibold sm:text-3xl">
              It measures attention saved, not content stored.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-indigo-100">
              Not a bookmark manager. Not a read-it-later app. The one question it answers: what
              deserves your attention right now — and why.
            </p>
            <Link
              to="/signup"
              className="mt-7 inline-flex items-center gap-2 rounded-lg bg-white px-5 py-3 font-medium text-indigo-700 hover:bg-indigo-50"
            >
              Clear your reading backlog <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="mx-auto max-w-5xl px-4 py-8 text-center text-sm text-gray-400">
        Knowledge Inbox Zero
      </footer>
    </div>
  );
}

// A sample library card for the hero demo. Pure presentational — mirrors the
// real card's verdict badge + reason + reading time + MKV so the landing shows
// the actual output, not a vague promise.
const DEMO_VERDICTS = {
  worth: {
    label: 'Worth it',
    badge: 'bg-emerald-100 text-emerald-800',
    accent: 'border-l-emerald-500',
  },
  maybe: { label: 'Maybe', badge: 'bg-amber-100 text-amber-800', accent: 'border-l-amber-500' },
  skip: { label: 'Skip', badge: 'bg-slate-200 text-slate-600', accent: 'border-l-slate-400' },
} as const;

function DemoCard({
  title,
  domain,
  verdict,
  reason,
  minutes,
  mkv,
}: {
  title: string;
  domain: string;
  verdict: keyof typeof DEMO_VERDICTS;
  reason: string;
  minutes: number;
  mkv: number;
}) {
  const v = DEMO_VERDICTS[verdict];
  const mkvTone =
    mkv >= 67
      ? 'bg-green-100 text-green-800'
      : mkv >= 34
        ? 'bg-amber-100 text-amber-800'
        : 'bg-gray-100 text-gray-600';
  return (
    <div
      className={`rounded-lg border border-l-4 border-gray-200 bg-white px-4 py-3 text-left ${v.accent}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">{title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-400">
            <span className="truncate">{domain}</span>
            <span className="inline-flex items-center gap-0.5">
              · <Clock className="h-3 w-3" /> {minutes} min
            </span>
          </p>
        </div>
        <span
          className={`shrink-0 rounded-md px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide ${v.badge}`}
        >
          {v.label}
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">{reason}</p>
      <span
        className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${mkvTone}`}
      >
        <span className="text-[0.65rem] font-bold uppercase tracking-wide opacity-70">MKV</span>
        {mkv}
      </span>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="mb-3">{icon}</div>
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      <p className="mt-2 text-sm text-gray-600">{body}</p>
    </div>
  );
}
