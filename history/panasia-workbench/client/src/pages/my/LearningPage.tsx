import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, BookOpen, ChevronLeft, ChevronRight, ExternalLink, PlayCircle } from 'lucide-react';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import DemoBadge from '@/components/demo-badge';
import { DEMO_MODE } from '@client/src/utils/config';
import { myApi } from '@client/src/api';
import type {
  LearningCourseProgress,
  MyLearning,
  MyLearningVideos,
} from '@shared/api.interface';

const CATEGORY_LABELS: Record<string, string> = {
  required: '必修',
  tutorial: '岗位教程',
  advanced: '进阶',
};

const categoryLabel = (
  category: LearningCourseProgress['category'],
): string => (category === null ? '—' : CATEGORY_LABELS[category] ?? '—');

const tutorialCaseId = (courseId: string): number | null => {
  const id = Number(courseId.replace('tutorial_case_', ''));
  return Number.isInteger(id) && id > 0 ? id : null;
};

const courseStatus = (progress: number): string => {
  if (progress >= 100) return '已完成';
  if (progress <= 0) return '未开始';
  return '进行中';
};

const courseStageInfo = (course: LearningCourseProgress): string | null => {
  if (course.progress >= 100) return null;
  const stage = course.currentStageTitle
    ? `当前：${course.currentStageTitle}`
    : null;
  const steps = course.stepsTotal
    ? `${course.stepsDone ?? 0}/${course.stepsTotal} 步`
    : null;
  if (!stage && !steps) return null;
  return [stage, steps].filter(Boolean).join(' · ');
};

const LearningPage = () => {
  const [data, setData] = useState<MyLearning | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    myApi
      .fetchMyLearning()
      .then((learning: MyLearning) => {
        if (!cancelled) setData(learning);
      })
      .catch(() => {
        if (!cancelled) setError('学习数据加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 培训视频单独取：媒体服务连不上只影响这一区
  const [videos, setVideos] = useState<MyLearningVideos | null>(null);
  useEffect(() => {
    let cancelled = false;
    myApi
      .fetchMyLearningVideos()
      .then((result: MyLearningVideos) => {
        if (!cancelled) setVideos(result);
      })
      .catch(() => {
        if (!cancelled) {
          setVideos({ configured: true, series: [], error: '培训视频暂时读不到，请稍后再试' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/my"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          返回我的
        </Link>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">学习中心</h1>
          {DEMO_MODE && <DemoBadge />}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          我的课程与考试情况
        </p>
      </div>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-40" />
          <Skeleton className="h-28" />
        </div>
      ) : error || !data ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error ?? '数据加载失败'}
        </div>
      ) : (
        <>
          <div data-ai-section-type="card-stat">
            <Card>
              <CardContent className="p-5">
                <p className="text-sm text-muted-foreground">需审核步骤完成</p>
                <p className="mt-1 text-3xl font-semibold">
                  {data.requiredDone}/{data.requiredTotal}
                </p>
              </CardContent>
            </Card>
          </div>

          <section>
            <h2 className="mb-3 text-base font-semibold">我的课程</h2>
            {data.courses.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                暂无进行中的教程案例，案例分配给你后会出现在这里
              </p>
            ) : (
              <div data-ai-section-type="card-list" className="space-y-3">
                {data.courses.map((course) => {
                  const stageInfo = courseStageInfo(course);
                  const caseId = tutorialCaseId(course.id);
                  const inner = (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-3">
                            <BookOpen className="h-5 w-5 text-muted-foreground" />
                            <span className="text-sm font-medium">
                              {course.title}
                            </span>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              {categoryLabel(course.category)}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {course.progress}% · {courseStatus(course.progress)}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center gap-3">
                          <Progress value={course.progress} className="flex-1" />
                          <span className="w-10 text-right text-xs text-muted-foreground">
                            {course.progress}%
                          </span>
                        </div>
                        {stageInfo ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {stageInfo}
                          </p>
                        ) : null}
                    </>
                  );
                  return caseId === null ? (
                    <Card key={course.id}>
                      <CardContent className="p-5">{inner}</CardContent>
                    </Card>
                  ) : (
                    <Link key={course.id} to={`/my/learning/case/${caseId}`}>
                      <Card className="transition-colors hover:bg-muted/50">
                        <CardContent className="p-5">
                          {inner}
                          <div className="mt-2 flex items-center justify-end gap-1 text-xs text-primary">
                            查看案例大纲
                            <ChevronRight className="h-3.5 w-3.5" />
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          {videos?.configured ? <TrainingVideos videos={videos} /> : null}

          <section>
            <h2 className="mb-3 text-base font-semibold">最近考试</h2>
            {data.exams.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                暂无考试记录，参加考试后会出现在这里
              </p>
            ) : (
              <div data-ai-section-type="card-list" className="space-y-3">
                {data.exams.map((exam) => (
                  <Card key={exam.id}>
                    <CardContent className="flex items-center justify-between gap-3 p-5">
                      <span className="text-sm font-medium">{exam.title}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm">
                          {exam.score === null ? '—' : `${exam.score} 分`}
                        </span>
                        {exam.passed ? (
                          <Badge className="border-green-200 bg-green-50 text-green-700">
                            通过
                          </Badge>
                        ) : (
                          <Badge className="border-red-200 bg-red-50 text-red-600">
                            未通过
                          </Badge>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>

        </>
      )}
    </div>
  );
};

/** 培训视频：按课程分组列出每一集，点开在新标签页进媒体服务的播放页（固定链接） */
const TrainingVideos = ({ videos }: { videos: MyLearningVideos }) => (
  <section>
    <h2 className="mb-3 text-base font-semibold">培训视频</h2>
    {videos.error ? (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {videos.error}
      </p>
    ) : videos.series.length === 0 ? (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        暂时没有给你的培训视频
      </p>
    ) : (
      <div data-ai-section-type="card-list" className="space-y-3">
        {videos.series.map((series) => (
          <Card key={series.name}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{series.name}</span>
                <span className="text-xs text-muted-foreground">
                  {series.items.length} 集
                </span>
              </div>
              <ul className="mt-3 divide-y">
                {series.items.map((item) => (
                  <li key={item.id}>
                    <UniversalLink
                      to={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 py-2.5 text-sm hover:text-primary"
                    >
                      <PlayCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 break-words">{item.title}</span>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </UniversalLink>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    )}
  </section>
);

export default LearningPage;
