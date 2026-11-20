import React, { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  LayoutDashboard,
  FolderKanban,
  AlertCircle,
  ClipboardCheck,
  Settings2,
} from 'lucide-react';

import AccountCenterMenu from '../../components/AccountCenterMenu';
import NotificationBell from '../../components/notifications/NotificationBell';
import ProtectedRoute from '../../components/ProtectedRoute';
import {
  clearStalePointerEvents,
  installRadixPointerEventsGuard,
} from '../../utils/radix-pointer-events-guard';

const NAV_ITEMS = [
  { to: '/admin', label: '总览', icon: LayoutDashboard, end: true },
  { to: '/admin/execute', label: '执行', icon: FolderKanban, end: false },
  { to: '/admin/problems', label: '问题', icon: AlertCircle, end: false },
  { to: '/admin/review', label: '验收', icon: ClipboardCheck, end: false },
  { to: '/admin/manage', label: '管理', icon: Settings2, end: false },
];

const AdminLayout: React.FC = () => {
  const location = useLocation();

  useEffect(() => installRadixPointerEventsGuard(), []);

  useEffect(() => {
    clearStalePointerEvents('路由变化');
  }, [location.pathname]);

  return (
    <ProtectedRoute requiredRoles={['boss', 'admin']}>
      <div className="min-h-screen bg-muted/40">
        <header className="sticky top-0 z-10 border-b bg-background">
          <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-6">
            <div className="flex items-center gap-2">
              <Link
                to="/"
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                返回工作台
              </Link>
              <span className="text-sm font-semibold tracking-tight">泛亚工作台</span>
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                管理端
              </span>
            </div>
            <div className="flex items-center gap-1">
              <NotificationBell />
              <AccountCenterMenu />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 pb-28 pt-6">
          <Outlet />
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mx-auto flex max-w-7xl items-stretch justify-around px-2 pb-[env(safe-area-inset-bottom)]">
            {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] leading-none transition-colors ${
                    isActive
                      ? 'font-medium text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`
                }
              >
                <Icon className="h-5 w-5" />
                {label}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </ProtectedRoute>
  );
};

export default AdminLayout;
