import { NavLink, Outlet } from 'react-router-dom';
import {
  ListTodo,
  FolderKanban,
  BriefcaseBusiness,
  TrendingUp,
  UserRound,
} from 'lucide-react';

import AccountCenterMenu from './AccountCenterMenu';
import NotificationBell from './notifications/NotificationBell';

const DOCKS = [
  { to: '/tasks', label: '任务', icon: ListTodo },
  { to: '/projects', label: '项目', icon: FolderKanban },
  { to: '/work', label: '工作', icon: BriefcaseBusiness },
  { to: '/performance', label: '绩效', icon: TrendingUp },
  { to: '/my', label: '我的', icon: UserRound },
];

const Layout = () => {
  return (
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-10 border-b bg-background">
        <div className="mx-auto flex h-12 max-w-6xl items-center justify-between px-6">
          <span className="text-sm font-semibold tracking-tight">泛亚工作台</span>
          <div className="flex items-center gap-1">
            <NotificationBell />
            <AccountCenterMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 pb-28 pt-6">
        <Outlet />
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-6xl items-stretch justify-around px-2 pb-[env(safe-area-inset-bottom)]">
          {DOCKS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
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
  );
};

export default Layout;
