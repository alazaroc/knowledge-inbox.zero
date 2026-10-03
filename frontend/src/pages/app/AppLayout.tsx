import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Library,
  PlusCircle,
  LogOut,
  Menu,
  X,
  SlidersHorizontal,
  UserCircle,
  ChevronDown,
} from 'lucide-react';
import type { Profile } from '@app/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import PageLoader from '../../components/ui/PageLoader';
import Footer from '../../components/Footer';

const NAV_ITEMS = [
  { to: '/app/library', label: 'Library', icon: Library },
  { to: '/app/add', label: 'Add content', icon: PlusCircle },
  { to: '/app/settings', label: 'Settings', icon: SlidersHorizontal },
];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Onboarding-first gate: until a real profile exists, the only reachable
  // app route is /app/settings (where the knowledge profile is edited). We
  // check once on mount; SettingsPage flips the flag by re-fetching after a
  // successful save, so we re-check on route change back out of settings.
  const [checking, setChecking] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  // Close the user dropdown on an outside click or Escape.
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [userMenuOpen]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const profile = await api.get<Profile>('/profile');
        if (active) setNotConfigured(Boolean(profile.notConfigured));
      } catch {
        // On a load error, don't trap the user — let them through.
        if (active) setNotConfigured(false);
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
    };
    // Re-run when leaving the profile page so the gate lifts right after save.
  }, [location.pathname]);

  const onLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  if (checking) return <PageLoader />;

  const onSetupPage = location.pathname.startsWith('/app/settings');
  if (notConfigured && !onSetupPage) {
    return <Navigate to="/app/settings" replace />;
  }

  const locked = notConfigured; // hide nav links while onboarding

  return (
    <div className="flex min-h-dvh flex-col bg-gray-50">
      <header className="app-header sticky top-0 z-30 border-b border-gray-200 bg-white">
        <div className="app-shell-width flex items-center justify-between">
          <div className="flex items-center gap-4">
            {!locked && (
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className="rounded p-1 text-gray-600 hover:bg-gray-100 sm:hidden"
                aria-label="Toggle menu"
              >
                {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            )}
            <Link to="/app" className="flex items-center gap-2 font-semibold text-gray-900">
              <img src="/logo.svg" alt="" className="h-6 w-6" />
              <span className="hidden sm:inline">Knowledge Inbox Zero</span>
            </Link>
            {!locked && (
              <nav className="hidden gap-1 text-sm sm:flex">
                {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                      `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors ${
                        isActive
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                      }`
                    }
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </NavLink>
                ))}
              </nav>
            )}
          </div>
          <div className="relative flex items-center text-sm" ref={userMenuRef}>
            <button
              type="button"
              onClick={() => setUserMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 font-medium text-gray-600 hover:bg-gray-100"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
                <UserCircle className="h-5 w-5" />
              </span>
              <span className="hidden max-w-[12rem] truncate sm:inline">{user?.email}</span>
              <ChevronDown
                className={`h-4 w-4 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {userMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
              >
                <div className="border-b border-gray-100 px-4 py-3">
                  <p className="truncate text-sm font-medium text-gray-900">{user?.email}</p>
                  <p className="text-xs text-gray-500">{user?.role}</p>
                </div>
                <NavLink
                  to="/app/profile"
                  onClick={() => setUserMenuOpen(false)}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                  role="menuitem"
                >
                  <UserCircle className="h-4 w-4 text-gray-500" />
                  My account
                </NavLink>
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    void onLogout();
                  }}
                  className="flex w-full items-center gap-2 border-t border-gray-100 px-4 py-2.5 text-left text-sm font-medium text-indigo-600 hover:bg-indigo-50"
                  role="menuitem"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Mobile nav drawer */}
      {!locked && menuOpen && (
        <nav className="border-b border-gray-200 bg-white sm:hidden">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-2 border-b border-gray-100 px-4 py-3 text-sm font-medium last:border-0 ${
                  isActive ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      )}

      <main className="app-main flex-1">
        <div className="app-shell-width">
          <Outlet />
        </div>
      </main>

      <Footer />
    </div>
  );
}
