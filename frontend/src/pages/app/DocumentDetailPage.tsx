import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, ArchiveRestore, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import type {
  KnowledgeDocument,
  RecommendationState,
  RecommendationTag,
  Scores,
} from '@app/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';

// Visual treatment for the single recommendation verdict (Req 6.1). The state
// is the one obvious next action, so it gets the most prominent styling.
const STATE_STYLES: Record<RecommendationState, string> = {
  READ: 'bg-green-100 text-green-800 ring-green-200',
  SKIM: 'bg-amber-100 text-amber-800 ring-amber-200',
  SKIP: 'bg-gray-100 text-gray-600 ring-gray-200',
};

// Tags are orthogonal reasons, not actions (OD-1) — rendered as subtle chips.
const TAG_STYLES: Record<RecommendationTag, string> = {
  FRESH: 'bg-sky-50 text-sky-700 ring-sky-200',
  REFERENCE: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  REDUNDANT: 'bg-orange-50 text-orange-700 ring-orange-200',
  OUTDATED: 'bg-rose-50 text-rose-700 ring-rose-200',
};

// The five numeric scores, in the order they tell the story: how relevant,
// how new, how redundant, how fresh, and the overall priority (MKV).
const SCORE_FIELDS: { key: keyof Scores; label: string; hint: string }[] = [
  { key: 'relevance', label: 'Relevance', hint: 'How relevant to you' },
  { key: 'novelty', label: 'Novelty', hint: 'How much is new to you' },
  { key: 'redundancy', label: 'Redundancy', hint: 'Overlap with what you know' },
  { key: 'freshness', label: 'Freshness', hint: 'How recent the content is' },
  { key: 'mkv', label: 'Priority (MKV)', hint: 'Overall marginal knowledge value' },
];

export default function DocumentDetailPage() {
  // Route is /app/library/:documentId (registered in App.tsx by the routing agent).
  const { documentId } = useParams<{ documentId: string }>();
  const navigate = useNavigate();
  // Reading the session keeps the shared api client authenticated (Req 8.12);
  // the client attaches the token and handles retry/backoff on its own.
  useAuth();

  const [doc, setDoc] = useState<KnowledgeDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState('');
  // In-flight lifecycle (archive/delete) and feedback actions.
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);

  const load = async () => {
    if (!documentId) {
      setError('No document was specified.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await api.get<KnowledgeDocument>(`/documents/${documentId}`);
      setDoc(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Re-queue this document for a fresh analysis against the CURRENT profile,
  // then poll until the new run lands (status leaves pending/processing).
  const handleReanalyze = async () => {
    if (!documentId || reanalyzing) return;
    setReanalyzing(true);
    setReanalyzeError('');
    try {
      await api.post(`/documents/${documentId}/reanalyze`, {});
      // Poll the document until it finishes re-processing (≤ ~45s).
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const fresh = await api.get<KnowledgeDocument>(`/documents/${documentId}`);
        if (fresh.status !== 'pending' && fresh.status !== 'processing') {
          setDoc(fresh);
          return;
        }
      }
      // Timed out polling — refresh once so the user sees the latest state.
      await load();
    } catch (err) {
      setReanalyzeError((err as Error).message);
    } finally {
      setReanalyzing(false);
    }
  };

  useEffect(() => {
    // Reload whenever the document id in the route changes.
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  // Toggle archived state via PATCH; archiving does not change owner-wide counts.
  const handleToggleArchive = async () => {
    if (!documentId || !doc || lifecycleBusy) return;
    setLifecycleBusy(true);
    setError('');
    try {
      const updated = await api.patch<KnowledgeDocument>(`/documents/${documentId}`, {
        archived: !doc.archived,
      });
      setDoc(updated);
    } catch (err) {
      setError((err as Error).message || 'Failed to update the document.');
    } finally {
      setLifecycleBusy(false);
    }
  };

  // Hard delete with confirmation; the backend decrements owner-wide counts.
  const handleDelete = async () => {
    if (!documentId || lifecycleBusy) return;
    const ok = window.confirm(
      'This permanently deletes the document. You may re-import it later. Continue?'
    );
    if (!ok) return;
    setLifecycleBusy(true);
    setError('');
    try {
      await api.delete(`/documents/${documentId}`);
      navigate('/app/library');
    } catch (err) {
      setError((err as Error).message || 'Failed to delete the document.');
      setLifecycleBusy(false);
    }
  };

  // Thumbs up/down on the classification. Clicking the active rating again
  // clears it (sends null). Signal only — does not change counts.
  const handleFeedback = async (value: 'up' | 'down') => {
    if (!documentId || !doc || feedbackBusy) return;
    const next = doc.userFeedback === value ? null : value;
    setFeedbackBusy(true);
    try {
      const updated = await api.patch<KnowledgeDocument>(`/documents/${documentId}`, {
        userFeedback: next,
      });
      setDoc(updated);
    } catch (err) {
      setError((err as Error).message || 'Failed to save your feedback.');
    } finally {
      setFeedbackBusy(false);
    }
  };

  const title = doc?.metadata?.title?.trim() || doc?.canonicalUrl || doc?.rawUrl || 'Document';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Link
          to="/app/library"
          className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
        >
          ← Back to library
        </Link>
        {doc && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleToggleArchive()}
              disabled={lifecycleBusy}
              title={doc.archived ? 'Unarchive this document' : 'Archive this document'}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {doc.archived ? (
                <>
                  <ArchiveRestore className="h-4 w-4" /> Unarchive
                </>
              ) : (
                <>
                  <Archive className="h-4 w-4" /> Archive
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={lifecycleBusy}
              title="Delete this document permanently"
              className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </button>
            <button
              type="button"
              onClick={() => void handleReanalyze()}
              disabled={reanalyzing}
              title="Re-score this document against your current profile"
              className="inline-flex items-center gap-2 rounded-md border border-indigo-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {reanalyzing ? 'Re-analyzing…' : 'Re-analyze'}
            </button>
          </div>
        )}
      </div>

      {reanalyzing && (
        <p className="rounded-md bg-indigo-50 px-4 py-2 text-sm text-indigo-800">
          Re-analyzing against your current profile — this takes a few seconds.
        </p>
      )}
      {reanalyzeError && (
        <p className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          Couldn&apos;t re-analyze: {reanalyzeError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : error ? (
        <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">We couldn&apos;t load this document. {error}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void load()}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Retry
            </button>
            <Link to="/app/library" className="text-sm font-medium text-indigo-600 hover:underline">
              Back to library
            </Link>
          </div>
        </div>
      ) : doc ? (
        <article className="space-y-6">
          {/* Header: title, source link, recommendation state and tags. */}
          <header className="space-y-3">
            <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              {doc.metadata?.author && <span>{doc.metadata.author}</span>}
              {doc.metadata?.sourceDomain && <span>· {doc.metadata.sourceDomain}</span>}
              {doc.metadata?.publishedAt && (
                <span>· {new Date(doc.metadata.publishedAt).toLocaleDateString()}</span>
              )}
            </div>
            <a
              href={doc.canonicalUrl || doc.rawUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block break-all text-sm text-indigo-600 hover:underline"
            >
              {doc.canonicalUrl || doc.rawUrl}
            </a>

            {/* Share image (og:image) when the page exposed one. Clicking opens
                the source. Hidden on load error so a dead image leaves no gap. */}
            {doc.metadata?.imageUrl && (
              <a
                href={doc.canonicalUrl || doc.rawUrl}
                target="_blank"
                rel="noreferrer"
                className="block"
              >
                <img
                  src={doc.metadata.imageUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    const el = e.currentTarget.parentElement;
                    if (el) el.style.display = 'none';
                  }}
                  className="max-h-72 w-full rounded-lg border border-gray-200 object-cover"
                />
              </a>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {doc.recommendationState && (
                <span
                  className={`rounded-full px-3 py-1 text-sm font-semibold ring-1 ${
                    STATE_STYLES[doc.recommendationState]
                  }`}
                >
                  {doc.recommendationState}
                </span>
              )}
              {doc.tags?.map((tag) => (
                <span
                  key={tag}
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${TAG_STYLES[tag]}`}
                >
                  {tag}
                </span>
              ))}
              {doc.degraded && (
                <span className="rounded-full bg-yellow-50 px-2 py-0.5 text-xs font-medium text-yellow-800 ring-1 ring-yellow-200">
                  Limited analysis
                </span>
              )}
            </div>
          </header>

          {/* PRIMARY output: the written explanation (Req 6.8). It covers why the
              document matters, what is new, the reason for the state, and what
              deserves attention vs. what can be ignored (Req 6.2, 8.9). */}
          <section className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50/60 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-indigo-700">
              Why this recommendation
            </h2>
            {doc.explanationUnavailable ? (
              <p className="text-sm text-indigo-900/70">
                We couldn&apos;t generate a written explanation for this document. The scores and
                recommendation below are still based on the analysis.
              </p>
            ) : doc.explanation ? (
              <p className="whitespace-pre-line text-base leading-relaxed text-indigo-950">
                {doc.explanation}
              </p>
            ) : (
              <p className="text-sm text-indigo-900/70">
                No explanation available for this document.
              </p>
            )}
          </section>

          {/* Feedback (Level 1 — collect signal only). Lets the user mark
              whether the classification was accurate. */}
          <section className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white px-5 py-3">
            <span className="text-sm font-medium text-gray-700">
              Was this classification helpful?
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleFeedback('up')}
                disabled={feedbackBusy}
                aria-pressed={doc.userFeedback === 'up'}
                title="Yes, this was accurate"
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:opacity-60 ${
                  doc.userFeedback === 'up'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <ThumbsUp className="h-4 w-4" /> Yes
              </button>
              <button
                type="button"
                onClick={() => void handleFeedback('down')}
                disabled={feedbackBusy}
                aria-pressed={doc.userFeedback === 'down'}
                title="No, this was off"
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:opacity-60 ${
                  doc.userFeedback === 'down'
                    ? 'border-rose-300 bg-rose-50 text-rose-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <ThumbsDown className="h-4 w-4" /> No
              </button>
            </div>
          </section>
          {doc.extraction && (
            <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-gray-900">What the content says</h2>

              {doc.extraction.summary && (
                <p className="text-sm leading-relaxed text-gray-700">{doc.extraction.summary}</p>
              )}

              {doc.extraction.claims.length > 0 && (
                <div className="space-y-1">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">
                    Key claims
                  </h3>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                    {doc.extraction.claims.map((claim, i) => (
                      <li key={i}>{claim}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-x-6 gap-y-3 pt-1">
                {doc.extraction.topics.length > 0 && (
                  <TagList label="Topics" values={doc.extraction.topics} />
                )}
                {doc.extraction.concepts.length > 0 && (
                  <TagList label="Concepts" values={doc.extraction.concepts} />
                )}
              </div>

              <dl className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-xs text-gray-500">
                <div className="flex gap-1">
                  <dt>Difficulty:</dt>
                  <dd className="font-medium text-gray-700">{doc.extraction.difficulty}</dd>
                </div>
                {doc.extraction.truncated && (
                  <div className="text-gray-400">Content was truncated before analysis.</div>
                )}
              </dl>
            </section>
          )}

          {/* SECONDARY supporting detail: the numeric scores (Req 6.8). Rendered
              smaller and below the written explanation. */}
          {doc.scores && (
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Supporting scores
              </h2>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {SCORE_FIELDS.map((field) => (
                  <ScoreStat
                    key={field.key}
                    label={field.label}
                    hint={field.hint}
                    value={doc.scores?.[field.key] as number | undefined}
                    estimated={
                      field.key === 'freshness' ? doc.scores?.freshnessEstimated : undefined
                    }
                  />
                ))}
              </dl>
            </section>
          )}
        </article>
      ) : (
        <p className="text-sm text-gray-500">Document not found.</p>
      )}
    </div>
  );
}

function TagList({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</h3>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span key={v} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

function ScoreStat({
  label,
  hint,
  value,
  estimated,
}: {
  label: string;
  hint: string;
  value?: number;
  estimated?: boolean;
}) {
  return (
    <div className="rounded border border-gray-100 bg-gray-50 px-3 py-2 text-center">
      <dt className="text-xs text-gray-500" title={hint}>
        {label}
      </dt>
      <dd className="text-base font-semibold text-gray-900">
        {typeof value === 'number' ? value : '—'}
        {estimated && <span className="ml-0.5 align-top text-xs text-gray-400">*</span>}
      </dd>
    </div>
  );
}
