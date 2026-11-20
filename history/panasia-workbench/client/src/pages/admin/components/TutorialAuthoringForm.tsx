import React, { useState } from 'react';
import {
  FormProvider,
  useFieldArray,
  useForm,
  useFormContext,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { createTutorialProject } from '@client/src/api/admin';
import type {
  TutorialAuthoringCreateRequest,
  TutorialAuthoringProjectView,
} from '@shared/api.interface';
import TutorialAuthoringStepEditor from './TutorialAuthoringStepEditor';

const MATERIAL_INPUT_TYPES = [
  'text',
  'textarea',
  'number',
  'select',
  'date',
  'image',
  'video',
  'file',
] as const;

const materialSchema = z.object({
  label: z.string().min(1, '材料名称不能为空'),
  inputType: z.enum(MATERIAL_INPUT_TYPES),
  required: z.boolean(),
  helpText: z.string(),
});

const stepSchema = z.object({
  title: z.string().min(1, '步骤标题不能为空'),
  guide: z.string(),
  warnText: z.string(),
  deliverNote: z.string(),
  videoUrl: z.string(),
  requireConfirm: z.boolean(),
  requireReview: z.boolean(),
  materials: z.array(materialSchema),
});

const stageSchema = z.object({
  title: z.string().min(1, '阶段标题不能为空'),
  description: z.string(),
  durationNote: z.string(),
  steps: z.array(stepSchema).min(1, '每个阶段至少要有一个步骤'),
});

const formSchema = z.object({
  name: z.string().min(1, '教程名称不能为空'),
  description: z.string(),
  stages: z.array(stageSchema).min(1, '至少要有一个阶段'),
});

export type TutorialAuthoringFormValues = z.infer<typeof formSchema>;

export function defaultFormValues(): TutorialAuthoringFormValues {
  return {
    name: '',
    description: '',
    stages: [
      {
        title: '',
        description: '',
        durationNote: '',
        steps: [
          {
            title: '',
            guide: '',
            warnText: '',
            deliverNote: '',
            videoUrl: '',
            requireConfirm: false,
            requireReview: false,
            materials: [],
          },
        ],
      },
    ],
  };
}

export function viewToFormValues(
  project: TutorialAuthoringProjectView,
): TutorialAuthoringFormValues {
  return {
    name: `${project.name}（副本）`,
    description: project.description ?? '',
    stages: project.stages.map((stage) => ({
      title: stage.title,
      description: stage.description ?? '',
      durationNote: stage.durationNote ?? '',
      steps: stage.steps.map((step) => ({
        title: step.title,
        guide: step.guide ?? '',
        warnText: step.warnText ?? '',
        deliverNote: step.deliverNote ?? '',
        videoUrl: step.videoUrl ?? '',
        requireConfirm: step.requireConfirm,
        requireReview: step.requireReview,
        materials: step.materials.map((material) => ({
          label: material.label,
          inputType: material.inputType,
          required: material.required,
          helpText: material.helpText ?? '',
        })),
      })),
    })),
  };
}

const optionalText = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value;

interface StageBlockProps {
  index: number;
  onRemove: () => void;
}

const StageBlock: React.FC<StageBlockProps> = ({ index, onRemove }) => {
  const { control } = useFormContext<TutorialAuthoringFormValues>();
  const { fields, append, remove } = useFieldArray({
    control,
    name: `stages.${index}.steps`,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">阶段 {index + 1}</CardTitle>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove}>
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-4">
          <FormField
            control={control}
            name={`stages.${index}.title`}
            render={({ field }) => (
              <FormItem className="md:col-span-2">
                <FormLabel>
                  阶段标题 <span className="text-destructive">*</span>
                </FormLabel>
                <FormControl>
                  <Input placeholder="如「准备阶段」" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name={`stages.${index}.durationNote`}
            render={({ field }) => (
              <FormItem className="md:col-span-2">
                <FormLabel>时长说明</FormLabel>
                <FormControl>
                  <Input placeholder="如「约 3 天」（选填）" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={control}
          name={`stages.${index}.description`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>阶段说明</FormLabel>
              <FormControl>
                <Textarea
                  className="min-h-[60px]"
                  placeholder="这个阶段要达成什么（选填）"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="space-y-3">
          {fields.map((field, stepIndex) => (
            <TutorialAuthoringStepEditor
              key={field.id}
              stageIndex={index}
              stepIndex={stepIndex}
              onRemove={() => remove(stepIndex)}
            />
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            append({
              title: '',
              guide: '',
              warnText: '',
              deliverNote: '',
              videoUrl: '',
              requireConfirm: false,
              requireReview: false,
              materials: [],
            })
          }
        >
          <Plus className="h-4 w-4" />
          添加步骤
        </Button>
      </CardContent>
    </Card>
  );
};

interface TutorialAuthoringFormProps {
  initial: TutorialAuthoringFormValues;
  onCancel: () => void;
  onCreated: () => void;
}

const TutorialAuthoringForm: React.FC<TutorialAuthoringFormProps> = ({
  initial,
  onCancel,
  onCreated,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<TutorialAuthoringFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initial,
  });
  const { fields: stageFields, append: appendStage, remove: removeStage } =
    useFieldArray({ control: form.control, name: 'stages' });

  const onSubmit = form.handleSubmit(async (data: TutorialAuthoringFormValues) => {
    setSubmitting(true);
    try {
      const request: TutorialAuthoringCreateRequest = {
        name: data.name.trim(),
        description: optionalText(data.description),
        stages: data.stages.map((stage) => ({
          title: stage.title,
          description: optionalText(stage.description),
          durationNote: optionalText(stage.durationNote),
          steps: stage.steps.map((step) => ({
            title: step.title,
            guide: optionalText(step.guide),
            warnText: optionalText(step.warnText),
            deliverNote: optionalText(step.deliverNote),
            videoUrl: optionalText(step.videoUrl),
            requireConfirm: step.requireConfirm,
            requireReview: step.requireReview,
            materials: step.materials.map((material) => ({
              label: material.label,
              inputType: material.inputType,
              required: material.required,
              helpText: optionalText(material.helpText),
            })),
          })),
        })),
      };
      const result = await createTutorialProject(request);
      toast.success(
        `教程「${result.name}」已创建：${result.stageCount} 个阶段、${result.stepCount} 个步骤`,
      );
      onCreated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建教程失败');
      logger.error('创建教程失败', error);
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <FormProvider {...form}>
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">教程信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      教程名称 <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如「新品上架操作」" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>教程简介</FormLabel>
                    <FormControl>
                      <Textarea
                        className="min-h-[60px]"
                        placeholder="一句话说清员工学完能独立做成什么事（选填）"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {stageFields.map((field, index) => (
            <StageBlock
              key={field.id}
              index={index}
              onRemove={() => removeStage(index)}
            />
          ))}

          <Button
            type="button"
            variant="outline"
            onClick={() =>
              appendStage({
                title: '',
                description: '',
                durationNote: '',
                steps: [
                  {
                    title: '',
                    guide: '',
                    warnText: '',
                    deliverNote: '',
                    videoUrl: '',
                    requireConfirm: false,
                    requireReview: false,
                    materials: [],
                  },
                ],
              })
            }
          >
            <Plus className="h-4 w-4" />
            添加阶段
          </Button>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? '创建中…' : '创建教程'}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              取消
            </Button>
          </div>
        </form>
      </Form>
    </FormProvider>
  );
};

export default TutorialAuthoringForm;
