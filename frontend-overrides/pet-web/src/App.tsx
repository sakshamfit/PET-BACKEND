/**
 * PET App Shell — Auth Gate + Role-Based Navigation
 * ===================================================
 *
 * This is the main app component that:
 * 1. Restores session (tries refresh token)
 * 2. Shows login if not signed in
 * 3. Shows role-based navigation (employee vs admin)
 * 4. Handles offline queue and build updates
 *
 * USER ROLES:
 * - employee: field staff, mobile-first, can register students, visits, tasks
 * - main_admin: Trust admin, sees all data, can add/disable staff, reports
 *
 * NAVIGATION:
 * - dashboard: home, attendance, my tasks
 * - students: list, search, register, detail
 * - tasks: my tasks + create
 * - visits: field visits to schools
 * - chat: conversations with team
 * - team: admin only, manage staff
 *
 * OFFLINE:
 * - useAutoSync() installs background sync that pushes queue when online
 * - SyncBadge shows queue count
 * - BuildWatcher polls /build-info.json for newer version
 */

import { useCallback, useEffect, useState } from 'react';
import { getPetUser, onPetAuthChange, petAuth, restoreSession } from './services/petApi';
import { LoginPage } from './pages/Login';
import { EmployeeDashboard } from './pages/EmployeeDashboard';
import { AdminDashboardPage } from './pages/AdminDashboard';
import { StudentsPage } from './pages/Students';
import { TasksPage } from './pages/Tasks';
import { VisitsPage } from './pages/Visits';
import { ChatPage } from './pages/Chat';
import { TeamPage } from './pages/Team';
import { useAutoSync } from './pages/sync';
import { BuildStamp, UpdateBanner, useBuildWatcher } from './build';

// All possible routes in the app
type Route = 'dashboard' | 'students' | 'tasks' | 'visits' | 'chat' | 'team';

// Navigation config: label, icon, and who can see it
const NAV: Array<{ key: Route; label: string; icon: string; adminOnly?: boolean }> = [
  { key: 'dashboard', label: 'Dashboard', icon: '⌂' },
  { key: 'students', label: 'Students', icon: '🎓' },
  { key: 'tasks', label: 'Tasks', icon: '✓' },
  { key: 'visits', label: 'Visits', icon: '🏫' },
  { key: 'chat', label: 'Chat', icon: '💬' },
  { key: 'team', label: 'Team', icon: '👥', adminOnly: true }, // Only admin sees Team
];

export default function App() {
  // Auth state: are we signed in?
  const [signedIn, setSignedIn] = useState(!!getPetUser());
  // Restoring session from refresh token (cold start)
  const [restoring, setRestoring] = useState(true);
  // Current route
  const [route, setRoute] = useState<Route>('dashboard');

  // Navigation handler
  const navigate = useCallback((r: string) => setRoute(r as Route), []);

  // Offline: auto-sync queue when online
  useAutoSync(signedIn);

  // Detects if server has newer build than this page
  // Shows "Update now" banner if behind
  const buildWatch = useBuildWatcher();

  // On mount: try to restore session from refresh token
  useEffect(() => {
    let alive = true;
    void restoreSession().then(ok => {
      if (!alive) return;
      setSignedIn(ok);
      setRestoring(false);
    });
    return () => { alive = false; };
  }, []);

  // Listen for auth changes (login/logout elsewhere)
  useEffect(() => onPetAuthChange(() => setSignedIn(!!getPetUser())), []);

  const user = getPetUser();

  // While restoring session, show spinner
  if (restoring) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-pet-700" />
      </div>
    );
  }

  // Not signed in → show login
  if (!signedIn) {
    return (
      <div className="min-h-dvh bg-slate-100">
        <LoginPage onLoggedIn={() => setSignedIn(true)} />
        <div className="p-4 text-center">
          <BuildStamp />
        </div>
      </div>
    );
  }

  // Signed in → show app shell
  const isAdmin = user?.role === 'main_admin';

  return (
    <div className="min-h-dvh bg-slate-100 pb-20">
      {/* Update banner if server has newer build */}
      <UpdateBanner watch={buildWatch} />

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <img src="/pet-icon.svg" alt="PET" className="h-7 w-7" />
            <span className="font-bold text-pet-900">PET Field</span>
            <span className="hidden sm:inline text-xs text-slate-500">
              · {isAdmin ? 'Main Admin' : 'Employee'} · {user?.name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="p-btn-ghost !min-h-8 !px-3 text-xs"
              onClick={() => {
                void petAuth.logout().then(() => setSignedIn(false));
              }}
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-6xl p-4 sm:ml-56 sm:mr-0 sm:max-w-[calc(100%-14rem)]">
        {route === 'dashboard' && (isAdmin ? <AdminDashboardPage navigate={navigate} /> : <EmployeeDashboard navigate={navigate} />)}
        {route === 'students' && <StudentsPage />}
        {route === 'tasks' && <TasksPage />}
        {route === 'visits' && <VisitsPage />}
        {route === 'chat' && <ChatPage />}
        {route === 'team' && isAdmin && <TeamPage />}
        {route === 'team' && !isAdmin && <div className="py-10 text-center text-sm text-slate-500">Admin only</div>}
      </main>

      {/* Bottom nav (mobile) + side nav (desktop) */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 bg-white sm:top-14 sm:bottom-auto sm:w-56 sm:border-r sm:border-t-0">
        <div className="flex justify-around sm:flex-col sm:p-2">
          {NAV.filter(item => !item.adminOnly || isAdmin).map(item => (
            <button
              key={item.key}
              onClick={() => navigate(item.key)}
              className={`flex flex-col sm:flex-row items-center gap-1 sm:gap-3 rounded-xl px-3 py-2 text-xs sm:text-sm font-medium transition ${
                route === item.key ? 'text-pet-800 bg-pet-50' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* Footer: build stamp */}
      <footer className="mx-auto max-w-6xl p-4 pt-10 text-center sm:ml-56">
        <BuildStamp />
      </footer>
    </div>
  );
}
