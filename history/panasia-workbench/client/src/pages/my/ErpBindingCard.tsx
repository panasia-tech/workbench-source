import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  deleteErpBinding,
  fetchErpBindingState,
  updateErpBinding,
} from '@client/src/api/erp';
import type { ErpBindingResponse } from '@shared/api.interface';

/**
 * ERP 账号绑定。用 ERP 账号从统一登录登进来的人（erpIdentity）服务端自动绑到自己的 ERP 账号，这里只读显示；
 * 手动改绑成别的账号的，提示进 ERP 要输一次密码、一键改回。不是 ERP 身份的照旧手动填
 */
const ErpBindingCard = () => {
  const [state, setState] = useState<ErpBindingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [erpUserId, setErpUserId] = useState('');
  const [erpUsername, setErpUsername] = useState('');
  const [saving, setSaving] = useState(false);

  const apply = useCallback((next: ErpBindingResponse) => {
    setState(next);
    setErpUserId(next.binding?.erpUserId ?? '');
    setErpUsername(next.binding?.erpUsername ?? '');
    setEditing(false);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    fetchErpBindingState()
      .then(apply)
      .catch(() => {
        toast.error('获取 ERP 绑定失败');
      })
      .finally(() => setLoading(false));
  }, [apply]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = () => {
    const trimmedId = erpUserId.trim();
    if (!trimmedId) {
      toast.error('请填写 ERP 账号 ID');
      return;
    }
    setSaving(true);
    updateErpBinding({
      erpUserId: trimmedId,
      erpUsername: erpUsername.trim() || undefined,
    })
      .then((next: ErpBindingResponse) => {
        apply(next);
        toast.success('ERP 账号已绑定，可从「工作」页免登录进入 ERP');
      })
      .catch(() => {
        toast.error('保存失败，请稍后重试');
      })
      .finally(() => setSaving(false));
  };

  /** 解绑；ERP 身份的人解绑后服务端马上自动绑回自己的 ERP 账号（= 改回） */
  const handleUnbind = (resetToOwn: boolean) => {
    setSaving(true);
    deleteErpBinding()
      .then((deleted: boolean) => {
        if (resetToOwn) {
          toast.success('已改回你登录用的 ERP 账号');
          load();
          return;
        }
        apply({ binding: null, erpIdentity: false, passwordFree: false });
        toast.success(deleted ? '已解绑 ERP 账号' : '本就未绑定');
      })
      .catch(() => {
        toast.error(resetToOwn ? '改回失败，请稍后重试' : '解绑失败，请稍后重试');
      })
      .finally(() => setSaving(false));
  };

  const binding = state?.binding ?? null;
  const erpIdentity = state?.erpIdentity === true;

  const renderBody = () => {
    if (loading) return <Skeleton className="h-20 w-full" />;
    if (binding && state?.passwordFree) {
      return (
        <div className="text-sm">
          <p className="font-medium">已自动绑定 {binding.erpUsername || binding.erpUserId}</p>
          <p className="mt-1 text-xs text-muted-foreground">就是你登录用的账号，进 ERP 不用输密码</p>
        </div>
      );
    }
    if (binding && !editing) {
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <p className="font-medium">{binding.erpUsername || binding.erpUserId}</p>
              <p className="mt-1 text-xs text-muted-foreground">账号 ID：{binding.erpUserId}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                修改
              </Button>
              {erpIdentity ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleUnbind(false)}
                  disabled={saving}
                  aria-label={`解绑 ERP 账号 ${binding.erpUserId}`}
                >
                  解绑
                </Button>
              )}
            </div>
          </div>
          {erpIdentity ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span>不是你登录用的 ERP 账号，进 ERP 要输一次密码</span>
              <Button size="sm" variant="outline" onClick={() => handleUnbind(true)} disabled={saving}>
                改回我的账号
              </Button>
            </div>
          ) : null}
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <div>
          <label htmlFor="erp-user-id" className="mb-1 block text-sm font-medium">
            ERP 账号 ID <span className="text-destructive">*</span>
          </label>
          <Input
            id="erp-user-id"
            value={erpUserId}
            onChange={(e) => setErpUserId(e.target.value)}
            placeholder="你在 ERP 系统里的账号标识"
          />
        </div>
        <div>
          <label htmlFor="erp-username" className="mb-1 block text-sm font-medium">
            ERP 用户名（选填）
          </label>
          <Input
            id="erp-username"
            value={erpUsername}
            onChange={(e) => setErpUsername(e.target.value)}
            placeholder="仅用于展示，如 张三"
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {binding ? '保存修改' : '绑定'}
          </Button>
          {binding && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(false);
                setErpUserId(binding.erpUserId);
                setErpUsername(binding.erpUsername ?? '');
              }}
              disabled={saving}
            >
              取消
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">ERP 账号绑定</CardTitle>
      </CardHeader>
      <CardContent>
        {erpIdentity ? null : (
          <p className="mb-4 text-sm text-muted-foreground">
            绑定 ERP 账号后，从「工作」页进入 ERP 工作台免登录直进。
          </p>
        )}
        {renderBody()}
      </CardContent>
    </Card>
  );
};

export default ErpBindingCard;
