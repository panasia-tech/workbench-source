import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BookOpen,
  Briefcase,
  CalendarCheck,
  ChevronRight,
  ClipboardList,
  Code2,
  FileText,
  FileX2,
  GraduationCap,
  History,
  LifeBuoy,
  Link2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { myApi } from '@client/src/api';
import DemoBadge from '@/components/demo-badge';
import { DEMO_MODE } from '@client/src/utils/config';
import { BindingSettingsForm } from './BindingSettingsForm';
import ErpBindingCard from './ErpBindingCard';
import ApiKeysCard from './ApiKeysCard';
import type {
  BindingOptionsResponse,
  MyOverview,
} from '@shared/api.interface';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';
import SubmitBlockerDialog from './SubmitBlockerDialog';
import DevRequestEntryCard from '../dev-requests/DevRequestEntryCard';

interface HrLink {
  key: string;
  label: string;
  icon: React.ReactNode;
  count: number | null;
  path: string;
}

const ROLE_LABELS: Record<string, string> = {
  procurement: '采购',
  sales: '销售',
  warehouse: '仓库',
  general: '通用',
  admin: '管理员',
};

const MyPage = () => {
  const [overview, setOverview] = useState<MyOverview | null>(null);
  const [options, setOptions] = useState<BindingOptionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blockerOpen, setBlockerOpen] = useState(false);

  const load = useCallback(() => {
    Promise.all([myApi.fetchMyOverview(), myApi.fetchBindingOptions()])
      .then(([ov, opts]) => {
        setOverview(ov);
        setOptions(opts);
        setError(null);
      })
      .catch(() => {
        setError('我的信息加载失败，请稍后重试');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reloadOverview = useCallback(() => {
    myApi
      .fetchMyOverview()
      .then((ov) => {
        setOverview(ov);
        toast.success('信息已刷新');
      })
      .catch(() => {
        toast.error('刷新失败');
      });
  }, []);

  if (loading && !overview) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (error || !overview || !options) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {error ?? '数据加载失败'}
      </div>
    );
  }

  const site = overview.frappeSiteUrl;

  const hrLinks: HrLink[] = [
    {
      key: 'salary-estimate',
      label: '预计薪资',
      icon: <Wallet className="h-5 w-5" />,
      count: null,
      path: '/my/salary',
    },
    {
      key: 'contract',
      label: '合同',
      icon: <FileText className="h-5 w-5" />,
      count: null,
      path: '/my/contract',
    },
    {
      key: 'attendance',
      label: '考勤',
      icon: <CalendarCheck className="h-5 w-5" />,
      count: overview.hrCounts.attendances,
      path: '/my/attendance',
    },
    {
      key: 'leave',
      label: '请假',
      icon: <ClipboardList className="h-5 w-5" />,
      count: overview.hrCounts.leaveApplications,
      path: '/my/leave',
    },
    {
      key: 'learning',
      label: '学习中心',
      icon: <GraduationCap className="h-5 w-5" />,
      count: overview.learning.courseCount,
      path: '/my/learning',
    },
    {
      key: 'salary-slip',
      label: '工资单',
      icon: <Wallet className="h-5 w-5" />,
      count: null,
      path: '/my/erp-payslip',
    },
    {
      key: 'appraisal',
      label: '绩效评估',
      icon: <FileText className="h-5 w-5" />,
      count: overview.hrCounts.appraisals,
      path: '/performance',
    },
    {
      key: 'exams',
      label: '考试记录',
      icon: <BookOpen className="h-5 w-5" />,
      count: null,
      path: '/my/learning',
    },
    {
      key: 'hosted-customers',
      label: '托管客户管理',
      icon: <Briefcase className="h-5 w-5" />,
      count: null,
      path: '/my/hosted-customers',
    },
    {
      key: 'tutorial-skips',
      label: '跳过申请',
      icon: <FileX2 className="h-5 w-5" />,
      count: null,
      path: '/my/tutorial-skips',
    },
  ];

  const renderHrEntry = (link: HrLink): React.ReactNode => (
    <CardContent className="flex items-center justify-between gap-3 p-5">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground">{link.icon}</span>
        <div>
          <p className="text-sm font-medium">{link.label}</p>
          <p className="text-xs text-muted-foreground">
            {link.count === null ? '点击查看' : `${link.count} 条记录`}
          </p>
        </div>
      </div>
      {link.path.startsWith('http') ? (
        <Button variant="ghost" size="sm" asChild>
          <UniversalLink
            to={link.path}
            target="_blank"
            rel="noreferrer"
          >
            <Link2 className="h-4 w-4" />
          </UniversalLink>
        </Button>
      ) : (
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      )}
    </CardContent>
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">我的</h1>
          {DEMO_MODE && <DemoBadge />}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          属于我自己的信息
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">个人档案</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-muted-foreground">姓名</p>
            <p className="mt-0.5 font-medium">
              {overview.userName ?? overview.userId}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">岗位</p>
            <p className="mt-0.5 font-medium">
              {overview.binding
                ? ROLE_LABELS[overview.binding.role]
                : '未设置'}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">HR 状态</p>
            <p className="mt-0.5 font-medium">
              {overview.employee
                ? `${overview.employee.name}（${
                    overview.employee.designation ?? '未设置职位'
                  }）`
                : '未关联 HR 员工'}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">员工绑定设置</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            绑定 Plane 成员后，任务与项目按你过滤；绑定岗位后，工作台显示对应入口。
          </p>
          {overview.canEditBinding ? (
            <BindingSettingsForm
              options={options}
              binding={overview.binding}
              onSaved={reloadOverview}
            />
          ) : (
            <p className="text-sm">
              {overview.binding
                ? `已绑定 ${overview.binding.planeMemberName ?? overview.binding.planeMemberId} · ${ROLE_LABELS[overview.binding.role] ?? overview.binding.role}`
                : '还没绑定'}
              <span className="text-muted-foreground">，要改请找管理员</span>
            </p>
          )}
        </CardContent>
      </Card>

      <ErpBindingCard />

      <ApiKeysCard />

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Briefcase className="h-4 w-4" />
          人事数据
        </h2>
        {overview.employee ? (
          <div data-ai-section-type="card-menu" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {hrLinks.map((link) =>
              link.path.startsWith('http') ? (
                <Card key={link.key} className="transition-shadow hover:shadow-md">
                  {renderHrEntry(link)}
                </Card>
              ) : (
                <Link key={link.key} to={link.path} className="block h-full">
                  <Card className="h-full transition-shadow hover:shadow-md">
                    {renderHrEntry(link)}
                  </Card>
                </Link>
              ),
            )}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            关联 Frappe HR 员工后，这里会显示你的工资单、请假、考勤与绩效数据
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <LifeBuoy className="h-4 w-4" />
          问题反馈
        </h2>
        <Card className="transition-shadow hover:shadow-md">
          <CardContent className="p-5">
            <button
              type="button"
              onClick={() => setBlockerOpen(true)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground">
                  <LifeBuoy className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-medium">遇到问题</p>
                  <p className="text-xs text-muted-foreground">
                    提交工作中遇到的阻塞，同类问题自动聚类，达阈值进入改进候选
                  </p>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <Code2 className="h-4 w-4" />
          开发需求
        </h2>
        <DevRequestEntryCard />
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <History className="h-4 w-4" />
          任务记录
        </h2>
        <Link to="/my/history" className="block">
          <Card className="transition-shadow hover:shadow-md">
            <CardContent className="flex items-center justify-between gap-3 p-5">
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground">
                  <History className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-medium">历史任务</p>
                  <p className="text-xs text-muted-foreground">
                    按日 / 周 / 月或任务序号查看已完成任务
                  </p>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </CardContent>
          </Card>
        </Link>
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <GraduationCap className="h-4 w-4" />
          培训中心
        </h2>
        {overview.learning.courseCount === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            暂无课程，课程发布后会出现在这里
          </p>
        ) : (
          <div data-ai-section-type="card-list" className="space-y-3">
            {overview.learning.courses.map((course) => (
              <Card key={course.id}>
                <CardContent className="flex items-center justify-between gap-3 p-5">
                  <div className="flex items-center gap-3">
                    <BookOpen className="h-5 w-5 text-muted-foreground" />
                    <span className="text-sm font-medium">{course.title}</span>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <UniversalLink
                      to={`${site}/lms/courses/${course.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      去学习
                    </UniversalLink>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <SubmitBlockerDialog
        open={blockerOpen}
        onOpenChange={setBlockerOpen}
      />
    </div>
  );
};

export default MyPage;
