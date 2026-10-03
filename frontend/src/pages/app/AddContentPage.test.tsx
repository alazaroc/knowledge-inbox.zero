import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Batch } from '@app/shared';

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false, logout: vi.fn(), refresh: vi.fn() }),
}));

import { api } from '../../lib/api';
import AddContentPage from './AddContentPage';

const mockGet = vi.mocked(api.get);
const mockPost = vi.mocked(api.post);

// 2.5s matches POLL_INTERVAL_MS in AddContentPage.
const POLL_INTERVAL_MS = 2500;

const processingBatch: Batch = {
  batchId: 'batch-1',
  ownerId: 'u1',
  status: 'processing',
  total: 1,
  pending: 0,
  processing: 1,
  completed: 0,
  failed: 0,
  rejected: [],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const finishedBatch: Batch = {
  ...processingBatch,
  status: 'finished',
  pending: 0,
  processing: 0,
  completed: 1,
  updatedAt: '2024-01-01T00:01:00.000Z',
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AddContentPage />
    </MemoryRouter>
  );
}

describe('AddContentPage polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  // Req 8.11: polling stops once the batch reaches a terminal state.
  it('stops polling once the batch is finished', async () => {
    mockPost.mockResolvedValueOnce({
      batchId: 'batch-1',
      total: 1,
      pending: 1,
      rejected: [],
      dailyLimit: 50,
      usedToday: 0,
      remaining: 49,
      blocked: [],
      duplicates: 0,
    });
    // First poll: still processing. Second poll: finished (terminal).
    mockGet.mockResolvedValueOnce(processingBatch).mockResolvedValueOnce(finishedBatch);

    renderPage();

    fireEvent.change(screen.getByLabelText(/urls/i), {
      target: { value: 'https://example.com/a' },
    });

    // Submitting kicks off: POST /imports, then an immediate first poll, then
    // an interval. flushing async work lets those microtasks settle under fake
    // timers (advanceTimersByTimeAsync drains the microtask queue each tick).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add to inbox/i }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // POST happened and the immediate first poll (processing batch) ran.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Advance one interval → second poll returns the finished (terminal) batch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(mockGet).toHaveBeenCalledTimes(2);

    // Terminal reached: advancing further must NOT trigger more polls (Req 8.11).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });
    expect(mockGet).toHaveBeenCalledTimes(2);

    // UI reflects the finished state.
    expect(screen.getByText('Finished')).toBeInTheDocument();
  });
});
