import type {
  BatchStatus,
  Difficulty,
  DocStatus,
  RecommendationState,
  RecommendationTag,
  Role,
} from './constants.js';

export interface Timestamped {
  createdAt: string;
  updatedAt: string;
}

export interface User extends Timestamped {
  userId: string;
  email: string;
  name: string;
  role: Role;
}

// Summary of a Cognito user for admin management.
export interface AdminUserSummary {
  username: string; // Cognito username (= email)
  email: string;
  role: Role;
  enabled: boolean;
  status: string; // Cognito UserStatus (CONFIRMED, FORCE_CHANGE_PASSWORD…)
  createdAt?: string;
}

export interface ApiList<T> {
  items: T[];
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Knowledge Inbox Zero domain
// ---------------------------------------------------------------------------

// Per-user knowledge profile — the single source of "what this user already
// knows and cares about". One item per user, keyed by Cognito sub.
export interface Profile extends Timestamped {
  userId: string;
  highInterests: string[];
  mediumInterests: string[];
  currentlyResearching: string[]; // active research/investigation
  alreadyKnown: string[]; // topics/concepts the user already knows
  avoidContentTypes: string[];
  activeContexts: string[]; // active initiatives/projects (distinct from research)
  context?: string; // free text "About you", <=2000 chars trimmed
  profileSourceUrl?: string; // optional public raw URL of the user's own profile.md
  profileRepoUrl?: string; // optional PRIVATE repo raw URL (token lives in Secrets Manager)
  hasToken?: boolean; // true when a private-repo token is stored for this user (read-only flag)
  notConfigured?: boolean; // true only for the synthetic empty profile (Req 1.4)
}

// Deterministic per-document scores (all 0..100). MKV is the overall priority.
export interface Scores {
  relevance: number; // 0..100
  novelty: number; // 0..100
  redundancy: number; // 0..100
  freshness: number; // 0..100
  mkv: number; // 0..100 overall priority
  freshnessEstimated?: boolean; // Req 5.9
}

// Metadata parsed from the retrieved document.
export interface DocMetadata {
  title?: string;
  author?: string;
  sourceDomain?: string;
  publishedAt?: string; // ISO date if found
  imageUrl?: string; // og:image / twitter:image — the page's own share thumbnail
}

// Structured LLM extraction of a document's content.
export interface Extraction {
  topics: string[];
  concepts: string[];
  claims: string[];
  difficulty: Difficulty;
  summary: string; // <=500 chars
  truncated?: boolean; // Req 4.6
  wordCount?: number; // word count of the extracted readable text (reading-time source)
}

// One analyzed document per canonical URL per owner.
export interface KnowledgeDocument extends Timestamped {
  documentId: string; // sha256(ownerId#canonicalUrl)
  ownerId: string;
  batchId: string;
  rawUrl: string;
  canonicalUrl: string;
  status: DocStatus;
  degraded?: boolean; // Req 4.5
  failureReason?: string; // Req 3.6, 3.9, 4.5
  metadata?: DocMetadata;
  extraction?: Extraction;
  scores?: Scores;
  recommendationState?: RecommendationState;
  tags?: RecommendationTag[];
  explanation?: string; // 50..1500 chars, or placeholder (Req 6.6)
  explanationUnavailable?: boolean; // Req 6.6
  s3ContentRef?: string; // set when raw content >300KB (Req 4.7)
  archived?: boolean; // user lifecycle: archived documents are hidden by default
  userFeedback?: 'up' | 'down'; // user's thumbs up/down on the classification (signal only)
  readingMinutes?: number; // estimated reading time in minutes (from Extraction.wordCount)
}

// A rejected import line and why it was rejected (Req 2.4).
export interface RejectedEntry {
  line: string;
  reason: string;
}

// Response of POST /imports. Beyond the created batch counts it reports the
// daily-quota outcome so the UI can show a hard-block message plus the exact
// URLs that were NOT processed (so the user can save them and retry tomorrow).
export interface ImportResult {
  batchId: string;
  total: number; // new docs enqueued + rejected (this batch)
  pending: number; // new docs enqueued
  rejected: RejectedEntry[]; // invalid URLs
  // Daily cost-control quota (USER role; ADMIN is unlimited → limit is null).
  dailyLimit: number | null;
  usedToday: number; // new docs enqueued today BEFORE this batch
  remaining: number | null; // null when unlimited
  // URLs accepted-as-valid but NOT enqueued because the daily limit was hit.
  // The user can copy these and retry the next day.
  blocked: string[];
  // URLs accepted that reused an existing document (duplicates); omitted when 0.
  duplicates?: number;
}

// An import batch with atomic progress counters (CP-10).
export interface Batch extends Timestamped {
  batchId: string;
  ownerId: string;
  status: BatchStatus;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  rejected: RejectedEntry[];
}

// Library listing response: a page of documents plus owner-wide state counts.
export interface LibraryResponse {
  documents: KnowledgeDocument[];
  counts: Record<RecommendationState, number> & { total: number };
  nextCursor?: string;
}
