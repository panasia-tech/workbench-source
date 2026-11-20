import React, { useEffect, useState } from 'react';

import { useAuth, ROLE_SUBJECT } from '@lark-apaas/client-toolkit/auth';
import { logger } from '@lark-apaas/client-toolkit/logger';

import { fetchAccountCenter } from '@client/src/api/my';

interface ProtectedRouteProps {
  requiredRoles: string[];
  children: React.ReactNode;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  requiredRoles,
  children,
}) => {
  const { ability, isLoading } = useAuth();
  const [serverCanAdmin, setServerCanAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAccountCenter()
      .then((data) => {
        if (!cancelled) setServerCanAdmin(data.canAdmin);
      })
      .catch((error: unknown) => {
        logger.error('获取管理端角色失败', error);
        if (!cancelled) setServerCanAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading || serverCanAdmin === null) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        正在加载权限…
      </div>
    );
  }

  const hasPermission =
    serverCanAdmin === true ||
    requiredRoles.some((role: string) => ability.can(role, ROLE_SUBJECT));

  if (!hasPermission) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-semibold">无访问权限</p>
        <p className="max-w-md text-sm text-muted-foreground">
          当前账号未分配管理端角色。请在角色面板把当前账号加入 boss
          或 admin 角色后刷新页面。
        </p>
      </div>
    );
  }

  return <>{children}</>;
};

export default ProtectedRoute;
