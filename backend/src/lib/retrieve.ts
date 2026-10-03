import * as cheerio from 'cheerio';
import type { DocMetadata } from '@app/shared';

// Result of attempting to retrieve + extract readable content for a URL.
export interface RetrieveResult {
  html?: string;
  text?: string;
  metadata: DocMetadata;
  degraded: boolean;
  reason?: string;
}

const RETRIEVE_TIMEOUT_MS = 15_000; // Req 4.4

/**
 * Build metadata containing only the source domain, used whenever retrieval
 * fails or the content is not parseable (Req 4.5). Falls back gracefully if the
 * URL cannot be parsed.
 */
export function domainOnly(url: string): DocMetadata {
  try {
    return { sourceDomain: new URL(url).hostname };
  } catch {
    return {};
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Decode a fetched HTML body honoring its declared charset.
 *
 * `Response.text()` always assumes UTF-8, which mangles pages served as
 * windows-1252 / ISO-8859-1 (common on older Spanish-content sites): accented
 * characters become U+FFFD "�". We instead read the raw bytes and pick the
 * charset from the HTTP `content-type`, then the `<meta charset>` /
 * `<meta http-equiv>` declaration, defaulting to UTF-8. Unknown labels fall
 * back to UTF-8 (TextDecoder would otherwise throw).
 */
function decodeBody(buffer: ArrayBuffer, contentType: string): string {
  const bytes = new Uint8Array(buffer);

  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  // Sniff the first ~2KB as latin1 (lossless byte→char) to read the <meta> tag
  // before we know the real charset — the charset declaration itself is ASCII.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];

  const label = (fromHeader || fromMeta || 'utf-8').toLowerCase();

  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // Unsupported/invalid charset label — decode as UTF-8 rather than fail.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Extract the readable main content + metadata from an HTML string using
 * cheerio (Req 4.2). cheerio is a pure Node HTML parser with no browser-asset
 * dependency, so it runs cleanly inside the Lambda bundle — unlike jsdom, which
 * reads a stylesheet file from its package directory at runtime that esbuild
 * does not bundle (ENOENT /browser/default-stylesheet.css crashed the worker).
 */
function readabilityExtract(html: string, url: string): { text?: string; metadata: DocMetadata } {
  const $ = cheerio.load(html);

  const metadata = domainOnly(url);

  // Title: prefer og:title, then <title>, then first <h1>.
  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').first().text().trim() ||
    $('h1').first().text().trim();
  if (title) metadata.title = title;

  // Author: common author meta tags, then rel=author.
  const author =
    $('meta[name="author"]').attr('content')?.trim() ||
    $('meta[property="article:author"]').attr('content')?.trim() ||
    $('[rel="author"]').first().text().trim();
  if (author) metadata.author = author;

  const published = readPublishedAt($);
  if (published) metadata.publishedAt = published;

  // Share thumbnail: og:image, then twitter:image. Resolve relative URLs
  // against the page URL (some sites emit a path-only og:image). http(s) only.
  const rawImage =
    $('meta[property="og:image"]').attr('content')?.trim() ||
    $('meta[property="og:image:url"]').attr('content')?.trim() ||
    $('meta[name="twitter:image"]').attr('content')?.trim() ||
    $('meta[name="twitter:image:src"]').attr('content')?.trim();
  if (rawImage) {
    try {
      const abs = new URL(rawImage, url).href;
      if (/^https?:\/\//i.test(abs)) metadata.imageUrl = abs;
    } catch {
      // Malformed image URL — just skip it.
    }
  }

  // Readable text: drop non-content noise, then prefer the main content region.
  $('script, style, noscript, nav, header, footer, aside, form, iframe, svg').remove();

  const container =
    pickFirstNonEmpty($, [
      'article',
      'main',
      '[role="main"]',
      '#content',
      '.content',
      '.container',
      '#root',
      '[class*="hero"]',
      'section',
    ]) ?? $('body');

  let text = normalizeWhitespace(container.text());

  // Fallback for landing/SaaS pages whose visible DOM is mostly chrome and
  // yields little text: synthesize a readable blob from metadata + headings +
  // paragraphs so a document still contributes topics to the extractor.
  if (text.length < 120) {
    text = landingFallbackText($, metadata) || text;
  }

  return { text: text || undefined, metadata };
}

/**
 * Build a best-effort text blob for pages with no substantial body text
 * (typical SaaS landing pages): title + meta/og description + headings +
 * paragraphs. Returns an empty string when nothing useful is found.
 */
function landingFallbackText($: cheerio.CheerioAPI, metadata: DocMetadata): string {
  const parts: string[] = [];

  if (metadata.title) parts.push(metadata.title);

  const description =
    $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[property="og:description"]').attr('content')?.trim();
  if (description) parts.push(description);

  $('h1, h2, h3').each((_, el) => {
    const t = normalizeWhitespace($(el).text());
    if (t) parts.push(t);
  });

  $('p, li').each((_, el) => {
    const t = normalizeWhitespace($(el).text());
    if (t.length > 20) parts.push(t);
  });

  return normalizeWhitespace(parts.join('. '));
}

/** First selector that yields a node with non-trivial text, else undefined. */
function pickFirstNonEmpty(
  $: cheerio.CheerioAPI,
  selectors: string[]
): cheerio.Cheerio<never> | undefined {
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length && normalizeWhitespace(el.text()).length > 120) {
      return el as unknown as cheerio.Cheerio<never>;
    }
  }
  return undefined;
}

/** Collapse runs of whitespace/newlines into single spaces and trim. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort extraction of a publication date from common metadata tags,
 * normalized to an ISO string when parseable.
 */
function readPublishedAt($: cheerio.CheerioAPI): string | undefined {
  const selectors = [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[name="date"]',
    'meta[name="dc.date"]',
    'meta[name="dc.date.issued"]',
    'meta[itemprop="datePublished"]',
    'meta[property="og:published_time"]',
  ];

  for (const selector of selectors) {
    const content = $(selector).attr('content')?.trim();
    if (content) {
      const parsed = new Date(content);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
  }

  const datetime = $('time[datetime]').first().attr('datetime')?.trim();
  if (datetime) {
    const parsed = new Date(datetime);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return undefined;
}

/**
 * Retrieve a URL and extract its readable main content + metadata.
 *
 * Degrades gracefully (never throws) returning `degraded: true` with a `reason`
 * for: fetch timeouts (Req 4.4), non-OK HTTP responses, non-HTML/text content
 * types, dead/unreachable links, and documents with no readable text (Req 4.5).
 */
export async function retrieveReadable(url: string): Promise<RetrieveResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RETRIEVE_TIMEOUT_MS); // Req 4.4
  // Never let a pending abort timer keep the Lambda/process event loop alive
  // (avoids a dangling handle; `clearTimeout` in `finally` is still the normal path).
  timer.unref?.();

  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });

    if (!res.ok) {
      return { metadata: domainOnly(url), degraded: true, reason: `http_${res.status}` };
    }

    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\//.test(type)) {
      // Req 4.5 — non-HTML/text (e.g. PDF, binary) is not parseable here.
      return { metadata: domainOnly(url), degraded: true, reason: 'unparseable_content_type' };
    }

    const html = decodeBody(await res.arrayBuffer(), type);
    const { text, metadata } = readabilityExtract(html, url);

    if (!text?.trim()) {
      // Req 4.5 — reachable but no extractable readable text.
      return { metadata, degraded: true, reason: 'no_readable_text' };
    }

    return { html, text, metadata, degraded: false };
  } catch (err) {
    return {
      metadata: domainOnly(url),
      degraded: true,
      reason: isAbortError(err) ? 'timeout' : 'fetch_failed',
    };
  } finally {
    clearTimeout(timer);
  }
}
