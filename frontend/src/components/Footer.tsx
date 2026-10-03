import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

const APP_VERSION = 'v0.1.0';
const REPO_URL = 'https://github.com/alazaroc/knowledge-inbox-zero';
const BLOG_URL = 'https://www.playingaws.com';
const GITHUB_URL = 'https://github.com/alazaroc';
const LINKEDIN_URL = 'https://www.linkedin.com/in/alejandrolazaro';

export default function Footer() {
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <>
      <footer className="mt-8 border-t border-gray-200 px-4 py-6 text-center text-xs text-gray-500">
        <nav className="app-shell-width flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            className="font-medium text-gray-600 hover:text-indigo-600"
          >
            About
          </button>
          <span aria-hidden className="text-gray-300">
            ·
          </span>
          <span>{APP_VERSION}</span>
        </nav>
      </footer>

      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
    </>
  );
}

function AboutModal({ onClose }: { onClose: () => void }) {
  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="About Knowledge Inbox Zero"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="" className="h-7 w-7" />
          <h2 className="text-lg font-semibold text-gray-900">Knowledge Inbox Zero</h2>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-gray-600">
          Paste the links you keep meaning to read. Each one is fetched, extracted and scored for
          how much it is worth your attention, so you can read what matters and skip the rest —
          inbox zero for your reading list.
        </p>

        <p className="mt-3 text-sm leading-relaxed text-gray-600">
          This is an open-source project.{' '}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-indigo-600 hover:underline"
          >
            View the code on GitHub
          </a>
          .
        </p>

        <div className="mt-5 border-t border-gray-100 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Who built it</p>
          <p className="mt-1 text-sm text-gray-600">
            Built by Alejandro Lázaro, AWS Community Builder &amp; Kiro Ambassador.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <a
              href={BLOG_URL}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-600 hover:underline"
            >
              Blog
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-600 hover:underline"
            >
              GitHub
            </a>
            <a
              href={LINKEDIN_URL}
              target="_blank"
              rel="noreferrer"
              className="text-indigo-600 hover:underline"
            >
              LinkedIn
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
