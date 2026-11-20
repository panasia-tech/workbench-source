import { ExternalLink, PackageCheck } from 'lucide-react';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';
import type { TutorialCaseMaterial } from '@shared/api.interface';

const INPUT_TYPE_LABELS: Record<string, string> = {
  text: '文本',
  textarea: '长文本',
  number: '数字',
  select: '单选',
  date: '日期',
  image: '图片',
  video: '视频',
  file: '文件',
};

interface StepGuidePanelProps {
  guide: string | null;
  deliverNote: string | null;
  videoUrl: string | null;
}

export function StepGuidePanel({
  guide,
  deliverNote,
  videoUrl,
}: StepGuidePanelProps) {
  if (!guide && !deliverNote && !videoUrl) return null;
  return (
    <div className="mt-4 space-y-2 rounded-lg border border-dashed border-primary/40 bg-primary/[0.03] p-3">
      <p className="text-xs font-medium text-primary">操作指引</p>
      {guide ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {guide}
        </p>
      ) : null}
      {deliverNote ? (
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <PackageCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">交付物：{deliverNote}</span>
        </p>
      ) : null}
      {videoUrl ? (
        <p>
          <UniversalLink
            to={videoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            查看操作演示视频
          </UniversalLink>
        </p>
      ) : null}
    </div>
  );
}

interface StepWarnNoteProps {
  text: string;
}

export function StepWarnNote({ text }: StepWarnNoteProps) {
  return (
    <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      注意：{text}
    </p>
  );
}

interface StepMaterialsPreviewProps {
  materials: TutorialCaseMaterial[];
}

export function StepMaterialsPreview({
  materials,
}: StepMaterialsPreviewProps) {
  if (materials.length === 0) {
    return <p className="text-sm text-muted-foreground">本步骤无需提交材料</p>;
  }
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">
        提交材料（预览）
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {materials.map((m: TutorialCaseMaterial) => (
          <li key={m.key} className="text-sm">
            <span className="font-medium">{m.label}</span>
            <span className="ml-1.5 text-xs text-muted-foreground">
              · {INPUT_TYPE_LABELS[m.inputType] ?? m.inputType}
              {m.required ? ' · 必填' : ' · 选填'}
            </span>
            {m.helpText ? (
              <p className="mt-0.5 break-words text-xs text-muted-foreground">
                {m.helpText}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
