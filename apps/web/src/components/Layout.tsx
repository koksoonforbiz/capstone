import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { PageContextProvider } from '../contexts/PageContext';
import { FloatingChatbot } from './FloatingChatbot';
import { useAuth } from '../contexts/AuthContext';
import { usePageViewTracker } from '../lib/activity-log';
import { useIdleLogout } from '../hooks/useIdleLogout';
import { IdleLogoutWarning } from './IdleLogoutWarning';

export function Layout() {
  const { user, logout } = useAuth();
  usePageViewTracker();

  // Auto-logout for clean session boundaries (Q1 fix).
  // Only enforced for students — teachers/admins working in the portal
  // shouldn't get bounced for being on a phone call. 15 min hard idle,
  // 60 s warning. The forced relogin starts a fresh StudentSession which
  // is what makes per-session data traceable end-to-end.
  const { isWarning, secondsUntilLogout, reset } = useIdleLogout({
    enabled: user?.role === 'student',
    idleMs: 15 * 60_000,
    warnMs: 60_000,
    onLogout: logout,
  });

  return (
    <PageContextProvider>
      <div className="min-h-screen bg-gray-100">
        <Header />
        <div className="flex">
          <Sidebar />
          <main className="flex-1 p-6">
            <Outlet />
          </main>
        </div>
      </div>
      {user && <FloatingChatbot />}
      <IdleLogoutWarning
        open={isWarning}
        secondsUntilLogout={secondsUntilLogout}
        onStayActive={reset}
        onLogoutNow={logout}
      />
    </PageContextProvider>
  );
}
