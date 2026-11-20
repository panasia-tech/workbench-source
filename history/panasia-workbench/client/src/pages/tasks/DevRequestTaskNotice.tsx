import { Link } from 'react-router-dom';
import { ChevronRight, Code2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface DevRequestTaskNoticeProps {
  devRequestId: string;
}

/** 任务详情碰到开发需求：不出通用按钮（开始 / 交凭证会绕过报价确认和验收），引导去开发需求页 */
export function DevRequestTaskNotice({ devRequestId }: DevRequestTaskNoticeProps) {
  return (
    <div className="flex flex-col gap-3 rounded-md bg-sky-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2 text-sm text-sky-800">
        <Code2 className="mt-0.5 h-4 w-4 shrink-0" />
        这是开发需求：报价、交付、验收都在开发需求页里做
      </p>
      <Button size="sm" asChild className="shrink-0">
        <Link to={`/dev-requests/${devRequestId}`}>
          去开发需求页
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}
