import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, LogIn } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchAuthOptions } from '@client/src/api/auth';
import { devLoginUrl, oidcLoginUrl } from '@client/src/utils/auth';
import type { AuthOptionsResponse } from '@shared/api.interface';

const DEV_ROLES = [
  { value: 'boss', label: '老板 boss' },
  { value: 'admin', label: '管理员 admin' },
];

function errorText(code: string | null, who: string | null): string | null {
  switch (code) {
    case 'not_provisioned':
      return `「${who ?? '这个账号'}」还没开通工作台，请把这个登录名发给管理员`;
    case 'disabled':
      return '这个账号已停用，请联系管理员';
    case 'conflict':
      return '这个工作台账号已绑定别的统一账号，请联系管理员';
    case 'expired':
      return '登录超时了，请再点一次登录';
    case 'idp':
      return '统一登录没有成功，请再试一次';
    case 'not_configured':
      return '统一登录还没配置好，请联系管理员';
    case 'invalid_user_id':
      return '账号对照有误，请联系管理员';
    case 'server':
      return '登录出错了，请稍后再试';
    case 'dev_user':
      return 'userId 只能是字母、数字、下划线或横线';
    default:
      return null;
  }
}

/** 登录页：统一账号（Authentik）一个按钮；本机开发开关下多一个开发登录 */
const LoginPage = () => {
  const [params] = useSearchParams();
  const [options, setOptions] = useState<AuthOptionsResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [devUserId, setDevUserId] = useState('');
  const [devName, setDevName] = useState('');
  const [devRoles, setDevRoles] = useState<string[]>([]);

  const next = params.get('next') || '/';
  const error = errorText(params.get('error'), params.get('who'));
  const loggedOut = params.get('logged_out') === '1';

  useEffect(() => {
    fetchAuthOptions()
      .then(setOptions)
      .catch(() => setLoadFailed(true));
  }, []);

  const toggleRole = (role: string, checked: boolean) => {
    setDevRoles((prev: string[]) =>
      checked ? [...new Set([...prev, role])] : prev.filter((item: string) => item !== role),
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-6 p-6">
          <div className="space-y-1 text-center">
            <h1 className="text-lg font-semibold">泛亚工作台</h1>
            {loggedOut && !error && (
              <p className="text-sm text-muted-foreground">已退出登录</p>
            )}
          </div>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          )}

          {!options && !loadFailed && (
            <div className="flex justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {loadFailed && (
            <p className="text-center text-sm text-muted-foreground">
              连不上服务器，请稍后刷新
            </p>
          )}

          {options?.oidcEnabled && (
            <Button
              className="w-full"
              onClick={() => window.location.assign(oidcLoginUrl(next))}
            >
              <LogIn className="h-4 w-4" />
              用{options.oidcProviderName}登录
            </Button>
          )}
          {options && !options.oidcEnabled && !options.devLoginEnabled && (
            <p className="text-center text-sm text-muted-foreground">
              登录还没配置好，请联系管理员
            </p>
          )}

          {options?.devLoginEnabled && (
            <form
              className="space-y-3 border-t pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                window.location.assign(
                  devLoginUrl({
                    userId: devUserId.trim(),
                    name: devName.trim(),
                    roles: devRoles,
                    next,
                  }),
                );
              }}
            >
              <p className="text-xs font-medium text-destructive">
                开发登录（仅本机，AUTH_DEV_LOGIN）
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="dev-user-id">妙搭 userId</Label>
                <Input
                  id="dev-user-id"
                  value={devUserId}
                  onChange={(event) => setDevUserId(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dev-name">姓名</Label>
                <Input
                  id="dev-name"
                  value={devName}
                  onChange={(event) => setDevName(event.target.value)}
                />
              </div>
              <div className="flex gap-4">
                {DEV_ROLES.map((role) => (
                  <label key={role.value} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={devRoles.includes(role.value)}
                      onCheckedChange={(checked) => toggleRole(role.value, checked === true)}
                    />
                    {role.label}
                  </label>
                ))}
              </div>
              <Button type="submit" variant="outline" className="w-full">
                开发登录
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default LoginPage;
