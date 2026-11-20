import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth, ROLE_SUBJECT } from '@lark-apaas/client-toolkit/auth';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  Check,
  ChevronDown,
  Loader2,
  LogOut,
  ShieldCheck,
  Upload,
  UserRoundPen,
  Users,
} from 'lucide-react';
import { z } from 'zod';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { logger } from '@lark-apaas/client-toolkit/logger';

import type { AccountCenterResponse, DemoAccountItem } from '@shared/api.interface';
import { clearDemoAs, setDemoAs } from '@client/src/utils/demo-view';
import { logoutUrl } from '@client/src/utils/auth';
import { fetchAccountCenter, updateAccountProfile } from '@client/src/api/my';
import {
  avatarImg1,
  avatarImg2,
  avatarImg3,
  avatarImg4,
  avatarImg5,
  avatarImg6,
  avatarImg7,
  avatarImg8,
  avatarImg9,
  avatarImg10,
  avatarImg11,
} from '@client/src/utils/img-resources/avatar-placeholders';
import { uploadFileToWorkbench } from '@client/src/utils/upload-to-workbench';

const profileSchema = z.object({
  name: z.string().min(1, '姓名不能为空'),
  email: z.string(),
  avatarUrl: z.string(),
});

type ProfileFormData = z.infer<typeof profileSchema>;

const AVATAR_PRESETS: string[] = [
  avatarImg1,
  avatarImg2,
  avatarImg3,
  avatarImg4,
  avatarImg5,
  avatarImg6,
  avatarImg7,
  avatarImg8,
  avatarImg9,
  avatarImg10,
  avatarImg11,
];

function initials(name: string | null | undefined): string {
  return (name ?? '·').slice(0, 1);
}

const AccountCenterMenu: React.FC = () => {
  const [account, setAccount] = useState<AccountCenterResponse | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { ability, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();

  const enterAdmin = () => {
    requestAnimationFrame(() => navigate('/admin'));
  };

  const view = account?.viewProfile ?? null;

  const form = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: '', email: '', avatarUrl: '' },
  });

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);

  const handleAvatarFile = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件');
      return;
    }
    setAvatarUploading(true);
    try {
      const url = await uploadFileToWorkbench(file);
      form.setValue('avatarUrl', url, { shouldValidate: true });
      toast.success('头像已上传，保存后生效');
    } catch (error) {
      logger.error('头像上传失败', error);
      toast.error('头像上传失败，请重试');
    } finally {
      setAvatarUploading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchAccountCenter()
      .then((data: AccountCenterResponse) => {
        if (!cancelled) setAccount(data);
      })
      .catch((error: unknown) => {
        logger.error('获取账户中心信息失败', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openSettings = () => {
    if (!view) {
      toast.error('账户资料尚未就绪，请稍后再试');
      return;
    }
    form.reset({
      name: view.name,
      email: view.email ?? '',
      avatarUrl: view.avatarUrl ?? '',
    });
    setSettingsOpen(true);
  };

  const onSubmit = form.handleSubmit(async (data: ProfileFormData) => {
    try {
      await updateAccountProfile({
        name: data.name,
        email: data.email || null,
        avatarUrl: data.avatarUrl || null,
      });
      toast.success('账户资料已保存');
      setSettingsOpen(false);
      const refreshed = await fetchAccountCenter();
      setAccount(refreshed);
    } catch (error) {
      logger.error('保存账户资料失败', error);
      toast.error('保存失败，请稍后重试');
    }
  });

  const switchAccount = (userId: string) => {
    setDemoAs(userId);
    window.location.reload();
  };

  const exitDemoView = () => {
    clearDemoAs();
    window.location.reload();
  };

  const abilityAdmin =
    !authLoading &&
    (ability.can('boss', ROLE_SUBJECT) || ability.can('admin', ROLE_SUBJECT));
  const canAdmin = abilityAdmin || account?.canAdmin === true;

  const currentAvatar = (item: DemoAccountItem | null, fallbackName: string | null) =>
    item?.avatarUrl ? (
      <AvatarImage src={item.avatarUrl} alt={item.name} />
    ) : (
      <AvatarFallback>{initials(item?.name ?? fallbackName)}</AvatarFallback>
    );

  return (
    <div className="flex items-center gap-2">
      {account?.isDemoView && view && (
        <Badge variant="secondary" className="hidden text-[11px] sm:inline-flex">
          演示视角：{view.name}
        </Badge>
      )}
      <DropdownMenu
        onOpenChange={(open: boolean) => {
          if (!open) setSwitcherOpen(false);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-9 w-9 rounded-full p-0"
            aria-label="账户中心"
          >
            <Avatar className="h-9 w-9 border">
              {currentAvatar(view, account?.realUser.name ?? null)}
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="flex items-center gap-3 p-3">
            <Avatar className="h-10 w-10 border">
              {currentAvatar(view, account?.realUser.name ?? null)}
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {view?.name ?? account?.realUser.name ?? '…'}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {view?.roleLabel ?? view?.email ?? account?.realUser.name ?? ''}
              </p>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openSettings}>
            <UserRoundPen className="h-4 w-4" />
            账户设置（姓名 / 邮箱 / 头像）
          </DropdownMenuItem>
          {(account?.demoAccounts.length ?? 0) > 0 && (
            <>
              <DropdownMenuItem
                onSelect={(event: Event) => {
                  event.preventDefault();
                  setSwitcherOpen((open: boolean) => !open);
                }}
              >
                <Users className="h-4 w-4" />
                切换演示账户
                <ChevronDown
                  className={`ml-auto h-4 w-4 text-muted-foreground transition-transform ${
                    switcherOpen ? 'rotate-180' : ''
                  }`}
                />
              </DropdownMenuItem>
              {switcherOpen &&
                (account?.demoAccounts ?? []).map((item: DemoAccountItem) => (
                  <DropdownMenuItem
                    key={item.userId}
                    className="pl-8"
                    onSelect={() => switchAccount(item.userId)}
                  >
                    <Avatar className="h-6 w-6 border">
                      {item.avatarUrl ? (
                        <AvatarImage src={item.avatarUrl} alt={item.name} />
                      ) : (
                        <AvatarFallback className="text-[10px]">
                          {initials(item.name)}
                        </AvatarFallback>
                      )}
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{item.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.roleLabel ?? '员工'}
                      </p>
                    </div>
                    {account?.viewUserId === item.userId && (
                      <Check className="h-4 w-4 text-primary" />
                    )}
                  </DropdownMenuItem>
                ))}
              {switcherOpen && account?.isDemoView && (
                <DropdownMenuItem className="pl-8" onSelect={exitDemoView}>
                  <LogOut className="h-4 w-4" />
                  退出演示视角
                </DropdownMenuItem>
              )}
            </>
          )}
          {canAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event: Event) => {
                  event.preventDefault();
                  enterAdmin();
                }}
              >
                <ShieldCheck className="h-4 w-4" />
                进入管理端
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              clearDemoAs();
              window.location.assign(logoutUrl());
            }}
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>账户设置</DialogTitle>
            <DialogDescription>
              配置当前视角账号（{view?.name ?? ''}）的展示资料，保存后立即生效。
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      姓名 <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="请输入姓名" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>邮箱</FormLabel>
                    <FormControl>
                      <Input placeholder="a65b595a25@example.invalid" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="avatarUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>头像</FormLabel>
                    <div className="flex items-center gap-4">
                      <Avatar className="h-16 w-16 border">
                        {field.value ? (
                          <AvatarImage src={field.value} alt="当前头像" />
                        ) : (
                          <AvatarFallback>
                            {initials(form.getValues('name'))}
                          </AvatarFallback>
                        )}
                      </Avatar>
                      <div className="flex flex-col gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={avatarUploading}
                          onClick={() => avatarInputRef.current?.click()}
                        >
                          {avatarUploading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Upload className="h-4 w-4" />
                          )}
                          {avatarUploading ? '上传中…' : '上传新头像'}
                        </Button>
                        {field.value ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            onClick={() => field.onChange('')}
                          >
                            清除头像
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const file = e.target.files?.[0];
                        if (file) void handleAvatarFile(file);
                        e.target.value = '';
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      或从预设头像中选择
                    </p>
                    <div className="grid grid-cols-6 gap-2">
                      {AVATAR_PRESETS.map((url: string) => (
                        <button
                          key={url}
                          type="button"
                          aria-label="选择预设头像"
                          onClick={() => field.onChange(url)}
                          className={`rounded-full border-2 transition-colors ${
                            field.value === url
                              ? 'border-primary'
                              : 'border-transparent hover:border-border'
                          }`}
                        >
                          <Avatar className="h-10 w-10">
                            <AvatarImage src={url} alt="预设头像" />
                          </Avatar>
                        </button>
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AccountCenterMenu;
