import { useState, type ChangeEvent } from 'react';
import dayjs from 'dayjs';
import { CalendarDays, Paperclip } from 'lucide-react';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  EvidenceUploader,
  type EvidenceFile,
} from '@client/src/pages/tasks/EvidenceUploader';
import type { TutorialCaseMaterial } from '@shared/api.interface';

/** image / video / file 三类走证据上传组件，data[key] 存 URL 数组 */
export function isFileInputType(inputType: string): boolean {
  return inputType === 'image' || inputType === 'video' || inputType === 'file';
}

export function fileNameFromUrl(url: string): string {
  const raw: string = url.split('/').pop() ?? url;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function urlsToFiles(value: unknown): EvidenceFile[] {
  if (!Array.isArray(value)) return [];
  const files: EvidenceFile[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '') continue;
    files.push({ name: fileNameFromUrl(item), size: 0, url: item });
  }
  return files;
}

interface MaterialFieldProps {
  material: TutorialCaseMaterial;
  value: unknown;
  onChange: (value: unknown) => void;
}

export function TutorialMaterialField({
  material,
  value,
  onChange,
}: MaterialFieldProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const textValue: string = typeof value === 'string' ? value : '';
  const dateValue: string | null = textValue !== '' ? textValue : null;

  const renderControl = () => {
    if (isFileInputType(material.inputType)) {
      return (
        <EvidenceUploader
          files={urlsToFiles(value)}
          onChange={(files: EvidenceFile[]) =>
            onChange(files.map((f: EvidenceFile) => f.url))
          }
        />
      );
    }
    if (material.inputType === 'textarea') {
      return (
        <Textarea
          value={textValue}
          rows={3}
          placeholder={`请输入${material.label}`}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
            onChange(e.target.value)
          }
        />
      );
    }
    if (material.inputType === 'select') {
      return (
        <Select value={textValue} onValueChange={(v: string) => onChange(v)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={`请选择${material.label}`} />
          </SelectTrigger>
          <SelectContent>
            {material.options.map((opt: string) =>
              opt === '' ? null : (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      );
    }
    if (material.inputType === 'date') {
      return (
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-start font-normal"
            >
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              {dateValue ?? `请选择${material.label}`}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={
                dateValue ? new Date(`${dateValue}T00:00:00`) : undefined
              }
              onSelect={(d: Date | undefined) => {
                if (!d) return;
                onChange(dayjs(d).format('YYYY-MM-DD'));
                setCalendarOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      );
    }
    return (
      <Input
        type={material.inputType === 'number' ? 'number' : 'text'}
        value={textValue}
        placeholder={`请输入${material.label}`}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
    );
  };

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">
        {material.label}
        {material.required ? (
          <span className="ml-0.5 text-destructive">*</span>
        ) : null}
      </label>
      {renderControl()}
      {material.helpText ? (
        <p className="text-xs text-muted-foreground">{material.helpText}</p>
      ) : null}
    </div>
  );
}

interface MaterialValueProps {
  material: TutorialCaseMaterial;
  value: unknown;
}

/** 已提交内容的只读展示 */
export function TutorialMaterialValue({ material, value }: MaterialValueProps) {
  const isEmpty =
    value == null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);

  if (isEmpty) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{material.label}</p>
        <p className="text-sm text-muted-foreground/70">未填写</p>
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{material.label}</p>
        <ul className="space-y-1">
          {value.map((item: unknown) =>
            typeof item === 'string' ? (
              <li key={item} className="flex items-center gap-1.5 text-sm">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <UniversalLink
                  to={item}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate text-primary hover:underline"
                >
                  {fileNameFromUrl(item)}
                </UniversalLink>
              </li>
            ) : (
              <li key={String(item)} className="text-sm">
                {String(item)}
              </li>
            ),
          )}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{material.label}</p>
      <p className="whitespace-pre-wrap break-words text-sm">
        {String(value)}
      </p>
    </div>
  );
}
