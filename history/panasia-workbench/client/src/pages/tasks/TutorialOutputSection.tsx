import { BookOpen, Video } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { TutorialTaskOutput } from '@shared/api.interface';

interface TutorialOutputSectionProps {
  output: TutorialTaskOutput;
}

/** 任务详情页「教程产出」卡：教程结构 + 各阶段步骤/实操视频标记 */
const TutorialOutputSection: React.FC<TutorialOutputSectionProps> = ({
  output,
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
        <span className="flex items-center gap-2">
          <BookOpen className="h-4 w-4" />
          教程产出
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          共 {output.stageCount} 个阶段 · {output.stepCount} 个步骤 ·{' '}
          {output.videoCount} 个实操视频
        </span>
      </CardTitle>
    </CardHeader>
    <CardContent className="space-y-4">
      <p className="font-bold">{output.projectName}</p>
      {output.stages.map((stage, stageIndex: number) => (
        <div key={stageIndex} className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {stage.title}
          </p>
          <div className="space-y-1">
            {stage.steps.map((step, stepIndex: number) => (
              <div
                key={stepIndex}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span>{step.title}</span>
                {step.hasVideo ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-green-600">
                    <Video className="h-3.5 w-3.5" />
                    实操视频
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </CardContent>
  </Card>
);

export default TutorialOutputSection;
