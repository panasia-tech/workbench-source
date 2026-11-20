import React, { useCallback, useEffect, useState } from 'react';
import { Link2, Pencil, Plus, RefreshCw, UserPlus, Users } from 'lucide-react';
import { Table, type TableColumnsType } from '@lark-apaas/client-toolkit/antd-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { getAdminEmployees } from '@client/src/api/admin';
import type {
  AdminEmployeeBindingRow,
  AdminUnboundAccountRow,
} from '@shared/api.interface';
import EmployeeBindingDialog, {
  type EmployeeBindingPreset,
} from './EmployeeBindingDialog';

const ROLE_LABELS: Record<string, string> = {
  procurement: '采购',
  sales: '销售',
  warehouse: '仓储',
  general: '通用',
  admin: '管理员',
};

/** 管理 Dock：员工绑定列表 + 代管新建/编辑 */
const EmployeesTab: React.FC = () => {
  const [employees, setEmployees] = useState<AdminEmployeeBindingRow[] | null>(
    null,
  );
  const [unbound, setUnbound] = useState<AdminUnboundAccountRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminEmployeeBindingRow | null>(null);
  const [preset, setPreset] = useState<EmployeeBindingPreset | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await getAdminEmployees();
      setEmployees(response.items ?? []);
      setUnbound(response.unbound ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取员工绑定列表失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSaved = useCallback(() => {
    void load();
  }, [load]);

  const columns: TableColumnsType<AdminEmployeeBindingRow> = [
    {
      title: '员工',
      dataIndex: 'userName',
      key: 'userName',
      width: 160,
      render: (_: unknown, record: AdminEmployeeBindingRow): string =>
        record.userName ?? record.miaodaUserId,
    },
    {
      title: 'Plane 成员',
      dataIndex: 'planeMemberName',
      key: 'planeMemberName',
      width: 160,
    },
    {
      title: '岗位',
      dataIndex: 'role',
      key: 'role',
      width: 120,
      render: (role: string): string => ROLE_LABELS[role] ?? role,
    },
    {
      title: 'HR 雇员',
      dataIndex: 'frappeEmployeeId',
      key: 'frappeEmployeeId',
      width: 160,
      render: (value: string | null): string => value ?? '—',
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_: unknown, record: AdminEmployeeBindingRow): React.ReactNode => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setEditing(record);
            setPreset(null);
            setDialogOpen(true);
          }}
        >
          <Pencil className="h-4 w-4" />
          编辑
        </Button>
      ),
    },
  ];

  const handleAdd = (): void => {
    setEditing(null);
    setPreset(null);
    setDialogOpen(true);
  };

  const handleBindAccount = (account: AdminUnboundAccountRow): void => {
    setEditing(null);
    setPreset({ miaodaUserId: account.miaodaUserId, userName: account.userName });
    setDialogOpen(true);
  };

  return (
    <div data-ai-section-type="card-list" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="h-5 w-5 text-primary" />
            员工绑定
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            员工与 Plane 成员、岗位角色的映射关系，由管理员在这里设置。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
          <Button onClick={handleAdd}>
            <Plus className="h-4 w-4" />
            新建绑定
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>员工绑定列表加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!error && employees === null && (
        <div className="rounded-xl border p-5 text-sm text-muted-foreground">
          正在加载员工绑定数据…
        </div>
      )}

      {!error && unbound.length > 0 && (
        <section className="space-y-3">
          <h3
            className="flex items-center gap-2 text-sm font-semibold"
            title="员工用统一账号登录过一次就会出现在这里，绑定后才看得到自己的任务"
          >
            <UserPlus className="h-4 w-4 text-primary" />
            待绑定 {unbound.length}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {unbound.map((account: AdminUnboundAccountRow) => (
              <div
                key={account.miaodaUserId}
                className="flex items-center justify-between gap-3 rounded-xl border p-5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {account.userName ?? account.loginName ?? account.miaodaUserId}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={account.miaodaUserId}
                  >
                    {account.loginName ?? account.miaodaUserId}
                  </div>
                </div>
                <Button size="sm" onClick={() => handleBindAccount(account)}>
                  <Link2 className="h-4 w-4" />
                  绑定
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {!error && employees !== null && employees.length === 0 && unbound.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无员工。员工用统一账号登录一次后会出现在这里。
        </div>
      )}

      {!error && employees !== null && employees.length > 0 && (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={employees}
          scroll={{ x: 700 }}
          pagination={false}
        />
      )}

      <EmployeeBindingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        preset={preset}
        onSaved={handleSaved}
      />
    </div>
  );
};

export default EmployeesTab;
