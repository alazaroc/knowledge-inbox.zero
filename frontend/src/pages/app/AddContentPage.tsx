import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Batch, ImportResult } from '@app/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';

// Poll batch progress no slower than every 5s (Req 8.11, 3.5). 2.5s keeps the
// UI feeling live while staying well under the ceiling.
const POLL_INTERVAL_MS = 2500;

// A batch is terminal when no document is still queued or in flight. The
// backend reports this as status === 'finished', equivalently pending+processing === 0.
const isTerminal = (batch: Batch): boolean =>
  batch.status === 'finished' || batch.pending + batch.processing === 0;

export default function AddContentPage() {
  // Reading the session keeps the shared api client authenticated (Req 8.12);
  // the client itself attaches the token and handles retry/backoff.
  useAuth();

  const [urls, setUrls] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [batch, setBatch] = useState<Batch | null>(null);
  const [createResult, setCreateResult] = useState<ImportResult | null>(null);
  // Whether the user just copied the blocked URLs (brief "Copied" confirmation).
  const [copiedBlocked, setCopiedBlocked] = useState(false);

  // Hidden file input used by the "Import bookmarks (HTML)" button.
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Capture-link entry point: the Settings bookmarklet (and any ?url=/text=
  // link) opens /app/add with the link as query params. Seed the textarea with
  // whatever carries links, then clear the params so a reload doesn't re-seed.
  // The auto-extract on submit pulls the URLs out of `text`.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const shared = [searchParams.get('url'), searchParams.get('text'), searchParams.get('title')]
      .filter(Boolean)
      .join('\n');
    if (shared) {
      setUrls((prev) => (prev ? `${prev}\n${shared}` : shared));
      setNotice('Added the link — press “Add to inbox” to analyze it.');
      // Strip the params so a refresh/back doesn't duplicate the seed.
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Extract every http(s) URL from an arbitrary blob of text, dedupe (keeping
  // order) and return them one per line. Lets the user paste a messy export,
  // a note from another tool, or a list of tabs — not just clean URLs.
  const extractUrls = (text: string): string[] => {
    const re = /https?:\/\/[^\s"'<>)\]]+/gi;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of text.matchAll(re)) {
      const u = m[0].replace(/[.,;]+$/, ''); // trailing punctuation from prose
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
    return out;
  };

  // Pull hrefs out of a browser bookmarks export (Netscape bookmark HTML, used
  // by Chrome/Firefox/Safari). Parsed in the browser — no backend parser.
  const parseBookmarksHtml = (html: string): string[] => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const hrefs = Array.from(doc.querySelectorAll('a[href]'))
      .map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '')
      .filter((h) => /^https?:\/\//i.test(h));
    const seen = new Set<string>();
    return hrefs.filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
  };

  // Merge newly found URLs into the textarea, deduping against what is there.
  const mergeIntoTextarea = (found: string[]) => {
    const existing = urls.split(/\s+/).filter(Boolean);
    const seen = new Set(existing);
    const added: string[] = [];
    for (const u of found) {
      if (!seen.has(u)) {
        seen.add(u);
        added.push(u);
      }
    }
    const next = [...existing, ...added];
    setUrls(next.join('\n'));
    return { added: added.length, total: next.length };
  };

  const onBookmarksFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setError('');
    try {
      const text = await file.text();
      const found = parseBookmarksHtml(text);
      if (found.length === 0) {
        setNotice('No bookmarks found in that file.');
        return;
      }
      const { added, total } = mergeIntoTextarea(found);
      setNotice(`Imported ${added} bookmark${added === 1 ? '' : 's'} (${total} URLs ready).`);
    } catch {
      setError('Could not read that file. Export your bookmarks as HTML and try again.');
    }
  };

  // Hold the interval id so we can clear it on terminal state and on unmount.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Clean up any live interval when the component unmounts (Req 8.11).
  useEffect(() => stopPolling, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);
    // Reset any previous run; keep the entered text until we know it was accepted.
    stopPolling();
    setBatch(null);
    setCreateResult(null);

    // Auto-extract: if the box holds arbitrary text (tabs dump, notes, a list
    // from another tool), pull the http(s) URLs out of it automatically — no
    // separate button to press. If no scheme'd URL is found we send the raw
    // text as-is, so hand-typed bare domains (example.com) still work (the
    // backend prepends https://).
    const extracted = extractUrls(urls);
    const payloadUrls = extracted.length > 0 ? extracted.join('\n') : urls;

    try {
      const res = await api.post<ImportResult>('/imports', { urls: payloadUrls });

      // Nothing enqueued AND nothing blocked by quota AND nothing rejected means
      // the submission carried no valid URL (Req 8.4). But if the daily limit
      // blocked everything (blocked > 0) that's a legitimate outcome to show.
      const nothingHappened =
        res.pending === 0 && res.blocked.length === 0 && res.rejected.length === 0;
      if (nothingHappened) {
        setError('At least one valid URL is required.');
        setSubmitting(false);
        return;
      }

      setCreateResult(res);
      setCopiedBlocked(false);
      // Submission processed: safe to clear the textarea. If the limit blocked
      // some URLs, they are preserved in `res.blocked` and shown below so the
      // user can copy and retry tomorrow.
      setUrls('');
      // Only poll when there is actually something in flight.
      if (res.pending > 0) startPolling(res.batchId);
    } catch (err) {
      // Surface backend 400 messages (e.g. empty submission, per-batch cap) verbatim.
      setError((err as Error).message || 'At least one valid URL is required.');
    } finally {
      setSubmitting(false);
    }
  };

  const startPolling = (batchId: string) => {
    const poll = async () => {
      try {
        const b = await api.get<Batch>(`/imports/${batchId}`);
        setBatch(b);
        // Req 8.11: stop polling once the batch reaches a terminal state.
        if (isTerminal(b)) stopPolling();
      } catch (err) {
        // Transient failures are already retried by the api client; surface a
        // persistent failure but keep the last known counts on screen.
        setError((err as Error).message);
      }
    };

    // Fetch immediately so the user sees counts without waiting a full interval,
    // then poll on a fixed cadence.
    void poll();
    pollRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
  };

  const processing = batch !== null && !isTerminal(batch);

  // Copy the quota-blocked URLs to the clipboard so the user can save and retry.
  const copyBlocked = async () => {
    if (!createResult?.blocked.length) return;
    try {
      await navigator.clipboard.writeText(createResult.blocked.join('\n'));
      setCopiedBlocked(true);
      setTimeout(() => setCopiedBlocked(false), 2000);
    } catch {
      // Clipboard denied (rare) — the list is already visible to copy manually.
    }
  };

  // Derived progress figures, resilient to the first render before the first
  // poll returns (fall back to the create acknowledgement).
  const total = batch?.total ?? createResult?.total ?? 0;
  const completed = batch?.completed ?? 0;
  const failed = batch?.failed ?? 0;
  const done = completed + failed;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="order-1">
        <h1 className="text-xl font-semibold text-gray-900">Add content</h1>
        <p className="text-sm text-gray-500">
          Paste the URLs you want analyzed, one per line. We canonicalize and dedupe them, then work
          through them in the background.
        </p>
      </div>

      <form onSubmit={onSubmit} className="order-3 space-y-3">
        <div className="space-y-1">
          <label htmlFor="urls" className="block text-sm font-medium text-gray-700">
            URLs
          </label>
          <p className="text-xs text-gray-500">One URL per line. Blank lines are ignored.</p>
          <textarea
            id="urls"
            className="input min-h-40 font-mono"
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder={'https://example.com/article\nhttps://example.com/another'}
          />
          {/* Ingestion helpers: import a browser bookmarks export, or extract
              URLs from any messy pasted text (notes, a list from another tool,
              a dump of open tabs). */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Import bookmarks (HTML)…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".html,.htm,text/html"
              className="hidden"
              onChange={(e) => void onBookmarksFile(e)}
            />
          </div>
          <p className="text-xs text-gray-400">
            Paste anything — a clean list, a messy note, or a dump of open tabs. We pull the links
            out for you when you press “Add to inbox”. Have a browser bookmarks file? Use “Bookmarks
            → Export as HTML” and import it here.
          </p>
          {notice && <p className="text-xs text-emerald-600">{notice}</p>}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : 'Add to inbox'}
        </button>

        <p className="text-xs text-gray-500">
          You can keep adding links while a batch is still being analyzed — each batch is processed
          on its own and your library fills in as they finish.
        </p>
      </form>

      {createResult && (
        <div className="order-2 space-y-4 rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Batch progress</h2>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                processing ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'
              }`}
            >
              {processing ? 'Analyzing…' : 'Finished'}
            </span>
          </div>

          {/* Duplicates: you already had these — reused, not re-analyzed. */}
          {createResult.duplicates ? (
            <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-800">
              {createResult.duplicates} {createResult.duplicates === 1 ? 'link was' : 'links were'}{' '}
              already in your library — reused, not analyzed again.
            </div>
          ) : null}

          {/* Daily-limit hard block: the remaining URLs were NOT processed.
              Show them so the user can copy, save and retry tomorrow. */}
          {createResult.blocked.length > 0 && (
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">
                Daily limit reached — {createResult.blocked.length} link
                {createResult.blocked.length === 1 ? '' : 's'} not processed
              </p>
              <p className="text-sm text-amber-800">
                You can analyze up to {createResult.dailyLimit} links per day. These weren’t
                processed — copy and save them, then add them again tomorrow. (Need more? Ask for
                extended access.)
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyBlocked()}
                  className="rounded border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
                >
                  {copiedBlocked ? 'Copied ✓' : 'Copy unprocessed links'}
                </button>
              </div>
              <ul className="max-h-48 space-y-0.5 overflow-auto rounded border border-amber-200 bg-white p-2 text-xs text-gray-700">
                {createResult.blocked.map((u, i) => (
                  <li key={`${u}-${i}`} className="font-mono break-all">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Remaining quota today (USER role only; ADMIN is unlimited). */}
          {createResult.remaining !== null && (
            <p className="text-xs text-gray-500">
              Daily quota: {createResult.remaining} of {createResult.dailyLimit} link
              {createResult.dailyLimit === 1 ? '' : 's'} left today.
            </p>
          )}

          {/* Visual progress bar: finished (completed+failed) over total. Only
              shown when there is pipeline work; a fully blocked/duplicate batch
              has total 0 and shows just the banners above. */}
          {total > 0 && (
            <>
              <div className="space-y-1">
                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-indigo-500 transition-all duration-500"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  {done} of {total} analyzed{processing ? '…' : ''}
                </p>
              </div>

              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <ProgressStat label="Total" value={total} />
                <ProgressStat label="Pending" value={batch?.pending ?? createResult.pending} />
                <ProgressStat label="Processing" value={batch?.processing ?? 0} />
                <ProgressStat label="Completed" value={batch?.completed ?? 0} />
                <ProgressStat label="Failed" value={failed} />
              </dl>
            </>
          )}

          {/* Clear end-state messaging — never leave the user guessing. */}
          {processing && (
            <p className="text-sm text-gray-600">
              We’re fetching each link, extracting its content and scoring it. This usually takes a
              few seconds per link — you can leave this page, your library will fill in on its own.
            </p>
          )}

          {!processing && completed > 0 && (
            <div className="rounded-md bg-green-50 p-4">
              <p className="text-sm text-green-800">
                {completed} {completed === 1 ? 'link is' : 'links are'} ready in your library.
              </p>
              <Link
                to="/app/library"
                className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
              >
                See your library →
              </Link>
            </div>
          )}

          {!processing && failed > 0 && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
              {failed} {failed === 1 ? 'link' : 'links'} couldn’t be analyzed (the page may be
              unreachable, blocked, or not readable). You can try adding{' '}
              {failed === 1 ? 'it' : 'them'} again later.
            </div>
          )}

          {!processing && completed === 0 && failed === 0 && (
            <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-600">
              Nothing was analyzed. Check the rejected lines below.
            </div>
          )}

          {createResult.rejected.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-gray-700">
                {createResult.rejected.length} line
                {createResult.rejected.length === 1 ? '' : 's'} rejected
              </p>
              <ul className="max-h-40 space-y-0.5 overflow-auto text-xs text-gray-500">
                {createResult.rejected.map((r, i) => (
                  <li key={`${r.line}-${i}`} className="font-mono">
                    {r.line} <span className="text-gray-400">({r.reason})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-gray-100 bg-gray-50 px-3 py-2 text-center">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-lg font-semibold text-gray-900">{value}</dd>
    </div>
  );
}
