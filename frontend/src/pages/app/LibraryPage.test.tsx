import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LibraryResponse } from '@app/shared';

// The api client reads import.meta.env.VITE_API_URL at module load and talks to
// the network, so we replace it wholesale with a controllable mock.
vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

// useAuth throws outside an AuthProvider; the page only needs it to exist.
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false, logout: vi.fn(), refresh: vi.fn() }),
}));

import { api } from '../../lib/api';
import LibraryPage from './LibraryPage';

const mockGet = vi.mocked(api.get);

const emptyLibrary: LibraryResponse = {
  documents: [],
  counts: { READ: 0, SKIM: 0, SKIP: 0, total: 0 },
};

const populatedLibrary: LibraryResponse = {
  documents: [
    {
      documentId: 'doc-1',
      ownerId: 'u1',
      batchId: 'b1',
      rawUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      status: 'completed',
      metadata: { title: 'First Doc', sourceDomain: 'example.com' },
      recommendationState: 'READ',
      scores: { relevance: 80, novelty: 70, redundancy: 10, freshness: 90, mkv: 75 },
      explanation: 'Worth your attention.',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ],
  counts: { READ: 1, SKIM: 0, SKIP: 0, total: 1 },
};

function renderPage() {
  return render(
    <MemoryRouter>
      <LibraryPage />
    </MemoryRouter>
  );
}

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Req 8.6: empty state shows the no-documents message and no per-state list.
  it('shows the empty state and no document list when there are no documents', async () => {
    mockGet.mockResolvedValueOnce(emptyLibrary);

    renderPage();

    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    // No per-state filter tabs / document list are rendered in the empty state.
    expect(screen.queryByRole('button', { name: /^All/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    // The attention-saved summary (part of the populated view) is absent.
    expect(screen.queryByText('Attention saved')).not.toBeInTheDocument();
  });

  // Req 8.7: a loading indicator is shown while the request is pending.
  it('shows a loading indicator while the request is pending', async () => {
    let resolve!: (value: LibraryResponse) => void;
    mockGet.mockReturnValueOnce(
      new Promise<LibraryResponse>((r) => {
        resolve = r;
      })
    );

    renderPage();

    // While pending, the loading skeleton is visible and no empty state yet.
    expect(screen.getByLabelText(/loading your library/i)).toBeInTheDocument();
    expect(screen.queryByText('No documents yet')).not.toBeInTheDocument();

    // Resolve so the pending promise doesn't leak into later assertions.
    resolve(emptyLibrary);
    await waitFor(() => expect(screen.getByText('No documents yet')).toBeInTheDocument());
  });

  // Req 8.8: an error shows a message and a Retry control; retrying re-calls the
  // api and renders documents on success.
  it('shows an error with a working Retry control', async () => {
    mockGet
      .mockRejectedValueOnce(new Error('Server unavailable'))
      .mockResolvedValueOnce(populatedLibrary);

    renderPage();

    // Error message + retry button after the failed load.
    expect(await screen.findByText('Server unavailable')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /retry/i });
    expect(retry).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Clicking Retry re-calls the api and, on success, renders the document.
    fireEvent.click(retry);

    expect(await screen.findByText('First Doc')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Server unavailable')).not.toBeInTheDocument();
  });
});
