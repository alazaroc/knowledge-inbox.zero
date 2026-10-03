import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArchiveRestore, Clock, Trash2, AlertTriangle, Search } from 'lucide-react';
import type {
  KnowledgeDocument,
  LibraryResponse,
  RecommendationState,
  RecommendationTag,
} from '@app/shared';
import { RECOMMENDATION_STATE, RECOMMENDATION_LABEL } from '@app/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';

// The filter tabs: "All" plus one per recommendation state. The active filter
// drives the ?state= query param (Req 8.5).
type Filter = 'ALL' | RecommendationState | 'FAILED';
const FILTERS: Filter[] = ['ALL', ...RECOMMENDATION_STATE, 'FAILED'];

// Visual treatment per state. The state is the dominant signal of the card:
// READ = act (green), SKIM = maybe (amber), SKIP = ignore (muted). Labels come
// from the shared RECOMMENDATION_LABEL map ("Worth it / Maybe / Skip").
const STATE_STYLES: Record<RecommendationState, { badge: string; accent: string }> = {
  READ: { badge: 'bg-emerald-100 text-emerald-800', accent: 'border-l-emerald-500' },
  SKIM: { badge: 'bg-amber-100 text-amber-800', accent: 'border-l-amber-500' },
  SKIP: { badge: 'bg-slate-200 text-slate-600', accent: 'border-l-slate-400' },
};

function buildPath(filter: Filter, cursor?: string): string {
  const params = new URLSearchParams();
  // FAILED is a client-only category (degraded docs have no backend state), so
  // it fetches everything and filters locally; ALL also fetches everything.
  if (filter !== 'ALL' && filter !== 'FAILED') params.set('state', filter);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `/documents?${qs}` : '/documents';
}

// Turn a worker failureReason code into a short, human explanation for the card.
function failureHint(reason?: string): string {
  if (!reason) return '';
  const r = reason.toLowerCase();
  if (r.includes('403') || r.includes('401')) return 'the site blocked automated access';
  if (r.includes('404') || r.includes('410')) return 'the page no longer exists';
  if (r.includes('429') || r.includes('too many requests') || r.includes('throttl'))
    return 'the service was rate-limited (try re-analyzing)';
  if (r.includes('no_readable_text')) return 'no readable text was found on the page';
  if (r.includes('fetch_failed')) return 'the page could not be reached';
  if (r.includes('timeout')) return 'fetching the page timed out';
  return '';
}

// Relative "time ago" for the card metadata line.
function timeAgo(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

// Sort by MKV descending (most valuable first). Degraded ("couldn't analyze")
// documents ALWAYS sink below every analyzed one — they have no meaningful
// score, so they belong at the end of the list, not interleaved by a fallback
// MKV. Within each group, ties break by updatedAt DESC.
function sortByValue(docs: KnowledgeDocument[]): KnowledgeDocument[] {
  return [...docs].sort((a, b) => {
    const aFailed = Boolean(a.degraded);
    const bFailed = Boolean(b.degraded);
    // Analyzed docs always rank above degraded ones.
    if (aFailed !== bFailed) return aFailed ? 1 : -1;
    const am = typeof a.scores?.mkv === 'number' ? a.scores.mkv : -1;
    const bm = typeof b.scores?.mkv === 'number' ? b.scores.mkv : -1;
    if (bm !== am) return bm - am;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });
}

export default function LibraryPage() {
  // Reading the session keeps the shared api client authenticated (Req 8.12);
  // the client itself attaches the token and handles retry/backoff.
  useAuth();

  const [filter, setFilter] = useState<Filter>('ALL');
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [counts, setCounts] = useState<LibraryResponse['counts'] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  // Archived visibility: active-only (default), archived-only, or all together.
  const [archivedView, setArchivedView] = useState<'active' | 'archived' | 'all'>('active');
  // Free-text filter over the loaded documents (title + domain + url).
  const [search, setSearch] = useState('');
  // Optional recommendation-tag filter (FRESH/REFERENCE/REDUNDANT/OUTDATED).
  const [tagFilter, setTagFilter] = useState<RecommendationTag | null>(null);
  // Per-document in-flight lifecycle action (archive/delete) to disable buttons.
  const [busyId, setBusyId] = useState<string | null>(null);

  // Fetch the first page for the current filter. The shared api client exhausts
  // its own retries/backoff before throwing (Req 8.12); a throw here is terminal
  // and surfaces the error + retry control (Req 8.8).
  const load = async (f: Filter) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<LibraryResponse>(buildPath(f));
      setDocuments(res.documents);
      setCounts(res.counts);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError((err as Error).message || 'Failed to load your library.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Re-fetch whenever the active filter changes.
    void load(filter);
  }, [filter]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError('');
    try {
      const res = await api.get<LibraryResponse>(buildPath(filter, nextCursor));
      setDocuments((prev) => [...prev, ...res.documents]);
      setCounts(res.counts);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError((err as Error).message || 'Failed to load more documents.');
    } finally {
      setLoadingMore(false);
    }
  };

  // Toggle archived state. Optimistic: update the item in place; archiving does
  // not change the owner-wide counts (the backend leaves COUNTS untouched).
  const toggleArchive = async (doc: KnowledgeDocument) => {
    setBusyId(doc.documentId);
    const nextArchived = !doc.archived;
    try {
      const updated = await api.patch<KnowledgeDocument>(`/documents/${doc.documentId}`, {
        archived: nextArchived,
      });
      setDocuments((prev) =>
        prev.map((d) => (d.documentId === doc.documentId ? { ...d, ...updated } : d))
      );
    } catch (err) {
      setError((err as Error).message || 'Failed to update the document.');
    } finally {
      setBusyId(null);
    }
  };

  // Hard delete, with confirmation. The backend decrements the owner-wide
  // counts, so we re-read them from the response is not possible (204) — we
  // adjust locally instead and drop the row.
  const deleteDoc = async (doc: KnowledgeDocument) => {
    const ok = window.confirm(
      'This permanently deletes the document. You may re-import it later. Continue?'
    );
    if (!ok) return;
    setBusyId(doc.documentId);
    try {
      await api.delete(`/documents/${doc.documentId}`);
      setDocuments((prev) => prev.filter((d) => d.documentId !== doc.documentId));
      setCounts((prev) => {
        if (!prev) return prev;
        const next = { ...prev, total: Math.max(0, prev.total - 1) };
        const s = doc.recommendationState;
        if (s && typeof next[s] === 'number') next[s] = Math.max(0, next[s] - 1);
        return next;
      });
    } catch (err) {
      setError((err as Error).message || 'Failed to delete the document.');
    } finally {
      setBusyId(null);
    }
  };

  // Visible list: sorted by MKV desc, archived hidden unless toggled, and the
  // FAILED tab shows only degraded docs (which carry no real state).
  const visibleDocs = useMemo(() => {
    // Archived visibility: active-only, archived-only, or all.
    let filtered =
      archivedView === 'active'
        ? documents.filter((d) => !d.archived)
        : archivedView === 'archived'
          ? documents.filter((d) => d.archived)
          : documents;
    if (filter === 'FAILED') {
      filtered = filtered.filter((d) => d.degraded);
    } else if (filter !== 'ALL') {
      // A state tab never shows degraded docs (their state is not meaningful).
      filtered = filtered.filter((d) => !d.degraded);
    }
    // Optional tag filter (FRESH/REFERENCE/REDUNDANT/OUTDATED).
    if (tagFilter) {
      filtered = filtered.filter((d) => d.tags?.includes(tagFilter));
    }
    // Free-text search over title, domain and URL (case-insensitive).
    const q = search.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((d) => {
        const hay = [
          d.metadata?.title ?? '',
          d.metadata?.sourceDomain ?? '',
          d.canonicalUrl ?? '',
          d.rawUrl ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return sortByValue(filtered);
  }, [documents, archivedView, filter, search, tagFilter]);

  // Tags actually present across the loaded docs, for the tag-filter chips.
  const presentTags = useMemo(() => {
    const set = new Set<RecommendationTag>();
    for (const d of documents) for (const t of d.tags ?? []) set.add(t);
    return [...set];
  }, [documents]);

  const failedCount = useMemo(() => documents.filter((d) => d.degraded).length, [documents]);

  const archivedCount = useMemo(() => documents.filter((d) => d.archived).length, [documents]);

  // Attention saved: documents the app judged do NOT deserve attention. SKIP is
  // the core signal; SKIM is partial. Surfaced as the primary success metric
  // rather than total stored (Req 8.10).
  const total = counts?.total ?? 0;
  const attentionSaved = counts ? counts.SKIP + counts.SKIM : 0;
  const savedPct = total > 0 ? Math.round((attentionSaved / total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Library</h1>
        <p className="text-sm text-gray-500">Your analyzed documents, most valuable first.</p>
      </div>

      {loading ? (
        // Req 8.7: loading indicator. Skeleton rows that keep the page layout
        // stable instead of a centered paragraph that reflows everything in.
        <LibrarySkeleton />
      ) : error ? (
        // Req 8.8: error message + retry control after the client's retries are exhausted.
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => void load(filter)}
            className="mt-3 rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      ) : total === 0 ? (
        // Req 8.6: empty state, and do NOT render any per-state document list.
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-900">No documents yet</p>
          <p className="mt-1 text-sm text-gray-500">
            Once you add content and we analyze it, your library will appear here.
          </p>
          <Link
            to="/app/add"
            className="mt-4 inline-block rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Add content
          </Link>
        </div>
      ) : (
        <>
          {/* Req 8.10: attention saved, prominent and on top. */}
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-6">
            <p className="text-sm font-medium uppercase tracking-wide text-indigo-700">
              Attention saved
            </p>
            <p className="mt-1 text-4xl font-bold text-indigo-900">
              {attentionSaved}
              <span className="text-xl font-semibold text-indigo-500"> / {total}</span>
            </p>
            <p className="mt-1 text-sm text-indigo-700">
              You saved attention on {attentionSaved} of {total} document
              {total === 1 ? '' : 's'} ({savedPct}%) that didn&apos;t deserve it.
            </p>
          </div>

          {/* Req 8.5: filter controls per state + "All", each with its count. */}
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => {
              const label =
                f === 'ALL' ? 'All' : f === 'FAILED' ? "Couldn't analyze" : RECOMMENDATION_LABEL[f];
              const count = f === 'ALL' ? counts!.total : f === 'FAILED' ? failedCount : counts![f];
              const active = f === filter;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  aria-pressed={active}
                  className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {label}{' '}
                  <span className={active ? 'text-indigo-100' : 'text-gray-400'}>({count})</span>
                </button>
              );
            })}

            {/* Archived visibility selector: active-only / archived-only / all.
                Keeps archived documents from mixing into the main list. */}
            <div className="ml-auto inline-flex items-center gap-1 rounded-lg bg-gray-100 p-0.5 text-xs">
              {(['active', 'archived', 'all'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setArchivedView(v)}
                  aria-pressed={archivedView === v}
                  className={`rounded-md px-2.5 py-1 font-medium capitalize transition ${
                    archivedView === v
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {v === 'archived' && archivedCount > 0 ? `Archived (${archivedCount})` : v}
                </button>
              ))}
            </div>
          </div>

          {/* Tag filter chips — only shown when documents carry tags. Click a
              tag to filter; click again to clear. */}
          {presentTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-400">
                Tags
              </span>
              {presentTags.map((t) => {
                const active = tagFilter === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTagFilter(active ? null : t)}
                    aria-pressed={active}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 transition ${
                      active
                        ? 'bg-indigo-600 text-white ring-indigo-600'
                        : 'bg-white text-gray-600 ring-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {t}
                  </button>
                );
              })}
              {tagFilter && (
                <button
                  type="button"
                  onClick={() => setTagFilter(null)}
                  className="text-xs text-gray-400 underline hover:text-gray-600"
                >
                  clear
                </button>
              )}
            </div>
          )}

          {/* Free-text search over the loaded documents. */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search your library by title, site or URL…"
              className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          {search.trim() && nextCursor && (
            <p className="text-xs text-amber-600">
              Searching the {documents.length} loaded documents. Click “Load more” below to search
              the rest.
            </p>
          )}

          {visibleDocs.length === 0 ? (
            <p className="text-sm text-gray-500">
              {search.trim()
                ? `No documents match “${search.trim()}”.`
                : 'No documents in this group.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {visibleDocs.map((doc) => (
                <li key={doc.documentId}>
                  <DocumentRow
                    doc={doc}
                    busy={busyId === doc.documentId}
                    onToggleArchive={() => void toggleArchive(doc)}
                    onDelete={() => void deleteDoc(doc)}
                  />
                </li>
              ))}
            </ul>
          )}

          {nextCursor && (
            <div className="flex justify-center">
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Skeleton shown while the first page loads. Mirrors the real card layout
// (title line, meta line, body, footer) so content does not jump when it
// arrives — the fix for the "everything disappears then pops in" flash.
function LibrarySkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading your library">
      <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-7 w-20 animate-pulse rounded-full bg-gray-100" />
        ))}
      </div>
      <ul className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="rounded-lg border border-l-4 border-gray-200 bg-white px-4 py-3">
            <div className="h-4 w-2/3 animate-pulse rounded bg-gray-100" />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-gray-100" />
            <div className="mt-3 h-3 w-full animate-pulse rounded bg-gray-100" />
            <div className="mt-3 h-5 w-16 animate-pulse rounded-full bg-gray-100" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocumentRow({
  doc,
  busy,
  onToggleArchive,
  onDelete,
}: {
  doc: KnowledgeDocument;
  busy: boolean;
  onToggleArchive: () => void;
  onDelete: () => void;
}) {
  const title = doc.metadata?.title?.trim() || doc.canonicalUrl || doc.rawUrl;
  const domain = doc.metadata?.sourceDomain ?? doc.canonicalUrl;
  const when = timeAgo(doc.updatedAt);
  // A degraded doc could not be fetched/extracted, so its scores and state are
  // not meaningful — treat it as its own "couldn't analyze" category rather than
  // showing an invented MKV/state.
  const failed = Boolean(doc.degraded);
  const state = failed ? null : doc.recommendationState;
  const mkv = !failed && typeof doc.scores?.mkv === 'number' ? doc.scores.mkv : null;
  const minutes = typeof doc.readingMinutes === 'number' ? doc.readingMinutes : null;
  const accent = failed
    ? 'border-l-rose-300'
    : state
      ? STATE_STYLES[state].accent
      : 'border-l-gray-200';

  // Lifecycle buttons live outside the <Link> navigation: stop propagation so a
  // click on Archive/Delete does not open the detail page.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  // --- Mobile swipe: left = Archive, right = Delete (with confirmation) ---
  // Horizontal drag shifts the card; crossing the threshold on release fires the
  // action. A mostly-vertical gesture is ignored so the page can still scroll.
  const SWIPE_THRESHOLD = 72;
  const startX = useRef(0);
  const startY = useRef(0);
  const dragging = useRef(false);
  const [dx, setDx] = useState(0);

  const onTouchStart = (e: React.TouchEvent) => {
    if (busy) return;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    dragging.current = true;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!dragging.current) return;
    const deltaX = e.touches[0].clientX - startX.current;
    const deltaY = e.touches[0].clientY - startY.current;
    // Ignore vertical scrolls: only track once horizontal clearly dominates.
    if (Math.abs(deltaX) < Math.abs(deltaY)) return;
    setDx(Math.max(-120, Math.min(120, deltaX)));
  };
  const onTouchEnd = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const d = dx;
    setDx(0);
    if (d <= -SWIPE_THRESHOLD)
      onToggleArchive(); // swipe left → archive
    else if (d >= SWIPE_THRESHOLD) onDelete(); // swipe right → delete (confirms)
  };

  // Which action the current drag will reveal, for the colored backdrop.
  const revealing = dx <= -1 ? 'archive' : dx >= 1 ? 'delete' : null;

  return (
    <div className="relative overflow-hidden rounded-lg">
      {/* Swipe backdrop (mobile only): shows the pending action under the card. */}
      {revealing && (
        <div
          className={`pointer-events-none absolute inset-0 flex items-center px-5 text-sm font-semibold sm:hidden ${
            revealing === 'archive'
              ? 'justify-end bg-amber-100 text-amber-800'
              : 'justify-start bg-red-100 text-red-700'
          }`}
          aria-hidden="true"
        >
          {revealing === 'archive' ? (
            <span className="inline-flex items-center gap-1">
              <Archive className="h-4 w-4" /> {doc.archived ? 'Unarchive' : 'Archive'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Trash2 className="h-4 w-4" /> Delete
            </span>
          )}
        </div>
      )}

      <Link
        to={`/app/library/${doc.documentId}`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        className={`relative block rounded-lg border border-l-4 border-gray-200 bg-white px-4 py-3 transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 ${accent} ${
          doc.archived ? 'opacity-60' : ''
        }`}
      >
        <div className="flex items-start justify-between gap-2 sm:gap-3">
          {/* Share thumbnail (og:image), when the page exposed one. Hidden on
              load error so a broken image never leaves an empty box. */}
          {doc.metadata?.imageUrl && !failed && (
            <img
              src={doc.metadata.imageUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
              className="h-14 w-14 shrink-0 rounded-md border border-gray-100 object-cover sm:h-16 sm:w-16"
            />
          )}
          <div className="min-w-0 flex-1">
            {/* Title — the primary line. Clamp to 2 lines on mobile so long
                titles do not overflow off-screen. */}
            <p className="line-clamp-2 text-sm font-semibold leading-snug text-gray-900 sm:text-base">
              {title}
            </p>
            {/* Thin meta line: domain · relative date · reading time. */}
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-400">
              <span className="truncate">{domain}</span>
              {when && <span>· {when}</span>}
              {minutes !== null && (
                <span className="inline-flex items-center gap-0.5">
                  · <Clock className="h-3 w-3" /> {minutes} min
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {state && (
              <span
                className={`rounded-md px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide sm:px-2.5 sm:py-1 sm:text-xs ${STATE_STYLES[state].badge}`}
              >
                {RECOMMENDATION_LABEL[state]}
              </span>
            )}
            {failed && (
              <span className="inline-flex items-center gap-1 rounded-md bg-rose-100 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-rose-700 sm:px-2.5 sm:py-1 sm:text-xs">
                <AlertTriangle className="h-3 w-3" /> Couldn&apos;t analyze
              </span>
            )}
            {doc.archived && (
              <span className="rounded-md bg-gray-100 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-gray-500">
                Archived
              </span>
            )}
          </div>
        </div>

        {/* Explanation, or the real reason analysis failed. */}
        {failed ? (
          <p className="mt-2 text-sm text-rose-700">
            This link couldn&apos;t be analyzed
            {failureHint(doc.failureReason) ? ` — ${failureHint(doc.failureReason)}` : ''}. No score
            was assigned.
          </p>
        ) : doc.explanation ? (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-gray-600">
            {doc.explanation}
          </p>
        ) : null}

        {/* Footer: MKV (analyzed only) + lifecycle actions. */}
        <div className="mt-2 flex items-center justify-between gap-3">
          {mkv !== null ? <MkvBadge value={mkv} /> : <span />}
          <div className="hidden items-center gap-1 sm:flex">
            <button
              type="button"
              onClick={stop(onToggleArchive)}
              disabled={busy}
              title={doc.archived ? 'Unarchive' : 'Archive'}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
            >
              {doc.archived ? (
                <>
                  <ArchiveRestore className="h-3.5 w-3.5" /> Unarchive
                </>
              ) : (
                <>
                  <Archive className="h-3.5 w-3.5" /> Archive
                </>
              )}
            </button>
            <button
              type="button"
              onClick={stop(onDelete)}
              disabled={busy}
              title="Delete permanently"
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
          {/* Mobile hint that swipe is available. */}
          <span className="text-[0.65rem] text-gray-300 sm:hidden">swipe ↔</span>
        </div>
      </Link>
    </div>
  );
}

// MKV (marginal knowledge value, 0-100) as a colored badge: the higher the
// score the more it is worth reading. Green = high, amber = medium, gray = low.
function MkvBadge({ value }: { value: number }) {
  const tone =
    value >= 67
      ? 'bg-green-100 text-green-800'
      : value >= 34
        ? 'bg-amber-100 text-amber-800'
        : 'bg-gray-100 text-gray-600';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}
      title="Marginal knowledge value (0–100)"
    >
      <span className="text-[0.65rem] font-bold uppercase tracking-wide opacity-70">MKV</span>
      {value}
    </span>
  );
}
