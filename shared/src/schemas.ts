import { z } from 'zod';
import { RECOMMENDATION_STATE, ROLES } from './constants.js';

// Profile list entries: trim, drop empties (Req 1.7), cap length/count (Req 1.8).
const trimmedEntry = z.string().transform((s) => s.trim());
const entryList = z
  .array(trimmedEntry)
  .transform((arr) => arr.filter((s) => s.length > 0)) // Req 1.7 drop empties
  .refine((arr) => arr.length <= 50, { message: 'At most 50 entries' })
  .refine((arr) => arr.every((s) => s.length <= 200), { message: 'Entry exceeds 200 chars' });

// ---------- Knowledge Inbox Zero domain ----------

// Profile: replace-all semantics; trims entries, drops empties, enforces bounds.
export const profileSchema = z.object({
  highInterests: entryList.default([]),
  mediumInterests: entryList.default([]),
  currentlyResearching: entryList.default([]),
  alreadyKnown: entryList.default([]),
  avoidContentTypes: entryList.default([]),
  activeContexts: entryList.default([]), // active initiatives/projects
  context: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length <= 2000, {
      message: 'context exceeds 2000 characters',
    })
    .optional(),
  // Optional PUBLIC raw URL of the user's own profile.md ("bring your own").
  // Only the URL is persisted; the worker fetches it at analysis time.
  profileSourceUrl: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s === '' || /^https:\/\/.+/.test(s), { message: 'Must be an https:// URL' })
    .refine((s) => s.length <= 2000, { message: 'URL exceeds 2000 characters' })
    .optional(),
  // Optional PRIVATE repo profile source. The URL is persisted on the profile;
  // the token is NOT — it is stored (write-only) in Secrets Manager and never
  // returned. Send githubToken='' to CLEAR a stored token.
  profileRepoUrl: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s === '' || /^https:\/\/.+/.test(s), { message: 'Must be an https:// URL' })
    .refine((s) => s.length <= 2000, { message: 'URL exceeds 2000 characters' })
    .optional(),
  githubToken: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length <= 400, { message: 'Token too long' })
    .optional(),
});

// Profile import (draft generation): give EITHER a public URL to fetch OR raw
// text pasted by the user. The worker/handler turns it into an editable draft
// profile via one LLM call — it is never saved directly (Req: review before save).
export const profileImportSchema = z
  .object({
    url: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s === '' || /^https:\/\/.+/.test(s), { message: 'Must be an https:// URL' })
      .refine((s) => s.length <= 2000, { message: 'URL exceeds 2000 characters' })
      .optional(),
    text: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length <= 50000, { message: 'Text exceeds 50000 characters' })
      .optional(),
  })
  .refine((v) => Boolean(v.url) || Boolean(v.text), {
    message: 'Provide a URL or paste some text',
  });

// Imports: raw pasted blob; the handler splits/normalizes lines (Req 2.1).
export const importCreateSchema = z.object({
  urls: z.string().min(1),
});

// Library query: optional state filter (Req 7.5 invalid → 400) + pagination cursor.
export const libraryQuerySchema = z.object({
  state: z.enum(RECOMMENDATION_STATE).optional(),
  cursor: z.string().optional(),
});

// Document PATCH: user lifecycle + feedback. At least one field required.
// `userFeedback: null` clears a prior thumbs rating.
export const documentPatchSchema = z
  .object({
    archived: z.boolean().optional(),
    userFeedback: z.enum(['up', 'down']).nullable().optional(),
  })
  .refine((v) => v.archived !== undefined || v.userFeedback !== undefined, {
    message: 'Nothing to update',
  });

// ---------- Users (admin management) ----------
// User creation by an admin (creates the Cognito user with a temporary password).
export const adminCreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'At least 8 characters').max(256),
  role: z.enum([ROLES.ADMIN, ROLES.USER]).default(ROLES.USER),
});

// User update by an admin: enable/disable and/or change role.
export const adminUpdateUserSchema = z
  .object({
    enabled: z.boolean().optional(),
    role: z.enum([ROLES.ADMIN, ROLES.USER]).optional(),
  })
  .refine((v) => v.enabled !== undefined || v.role !== undefined, {
    message: 'Nothing to update',
  });

// Inferred types
export type AdminCreateUserInput = z.infer<typeof adminCreateUserSchema>;
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;
export type ProfileInput = z.input<typeof profileSchema>;
export type ProfileImportInput = z.input<typeof profileImportSchema>;
export type ImportCreateInput = z.input<typeof importCreateSchema>;
export type LibraryQueryInput = z.input<typeof libraryQuerySchema>;
export type DocumentPatchInput = z.infer<typeof documentPatchSchema>;
