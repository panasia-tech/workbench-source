import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Code2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { fetchDevRequestTodoCount } from '@client/src/api/dev-requests';

/** 「我的」「工作」页的开发需求入口；轮到自己处理的条数读不到就不显示（不打扰） */
const DevRequestEntryCard = () => {
  const [todo, setTodo] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDevRequestTodoCount()
      .then((response) => {
        if (!cancelled) setTodo(response.count);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Link to="/dev-requests" className="block">
      <Card className="transition-shadow hover:shadow-md">
        <CardContent className="flex items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground">
              <Code2 className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-medium">开发需求</p>
              <p className="text-xs text-muted-foreground">发需求、报价、交付、验收</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {todo !== null && todo > 0 ? (
              <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-medium text-white">
                待处理 {todo}
              </span>
            ) : null}
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
};

export default DevRequestEntryCard;
