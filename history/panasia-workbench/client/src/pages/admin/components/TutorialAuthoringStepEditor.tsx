import React from 'react';
import { useFieldArray, useFormContext } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import type { TutorialAuthoringFormValues } from './TutorialAuthoringForm';

const MATERIAL_TYPE_OPTIONS = [
  { value: 'text', label: '单行文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '下拉选择' },
  { value: 'date', label: '日期' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'file', label: '文件' },
] as const;

interface TutorialAuthoringStepEditorProps {
  stageIndex: number;
  stepIndex: number;
  onRemove: () => void;
}

const TutorialAuthoringStepEditor: React.FC<TutorialAuthoringStepEditorProps> = ({
  stageIndex,
  stepIndex,
  onRemove,
}) => {
  const { control } = useFormContext<TutorialAuthoringFormValues>();
  const { fields, append, remove } = useFieldArray({
    control,
    name: `stages.${stageIndex}.steps.${stepIndex}.materials`,
  });

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">
          步骤 {stepIndex + 1}
        </span>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove}>
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>

      <FormField
        control={control}
        name={`stages.${stageIndex}.steps.${stepIndex}.title`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              步骤标题 <span className="text-destructive">*</span>
            </FormLabel>
            <FormControl>
              <Input placeholder="员工要做的一件事，如「办理营业执照」" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid gap-3 md:grid-cols-2">
        <FormField
          control={control}
          name={`stages.${stageIndex}.steps.${stepIndex}.guide`}
          render={({ field }) => (
            <FormItem className="md:col-span-2">
              <FormLabel>操作指引</FormLabel>
              <FormControl>
                <Input
                  placeholder="怎么操作：一步一句，动作清晰（选填）"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={`stages.${stageIndex}.steps.${stepIndex}.warnText`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>易错提醒</FormLabel>
              <FormControl>
                <Input placeholder="这一步最容易错的地方（选填）" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={`stages.${stageIndex}.steps.${stepIndex}.deliverNote`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>完成标准</FormLabel>
              <FormControl>
                <Input placeholder="做到什么样算完成（选填）" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={`stages.${stageIndex}.steps.${stepIndex}.videoUrl`}
          render={({ field }) => (
            <FormItem className="md:col-span-2">
              <FormLabel>实操视频链接</FormLabel>
              <FormControl>
                <Input placeholder="视频 URL，来自任务凭证（选填）" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="flex flex-wrap gap-6 pt-1">
        <FormField
          control={control}
          name={`stages.${stageIndex}.steps.${stepIndex}.requireConfirm`}
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-2 space-y-0">
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <FormLabel className="font-normal text-sm">
                学员需点确认完成
              </FormLabel>
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={`stages.${stageIndex}.steps.${stepIndex}.requireReview`}
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-2 space-y-0">
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
              <FormLabel className="font-normal text-sm">
                需老板审核后才算过（闸口步骤才开）
              </FormLabel>
            </FormItem>
          )}
        />
      </div>

      <div className="space-y-2 border-t pt-3">
        <div className="flex items-center justify-between">
          <FormLabel className="text-sm">提交材料</FormLabel>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              append({ label: '', inputType: 'image', required: true, helpText: '' })
            }
          >
            <Plus className="h-4 w-4" />
            添加材料
          </Button>
        </div>
        {fields.length === 0 && (
          <p className="text-xs text-muted-foreground">
            无需提交材料的步骤可留空。
          </p>
        )}
        {fields.map((materialField, materialIndex) => (
          <div
            key={materialField.id}
            className="space-y-2 rounded-md border bg-background p-3"
          >
            <div className="flex flex-wrap items-end gap-2">
              <FormField
                control={control}
                name={`stages.${stageIndex}.steps.${stepIndex}.materials.${materialIndex}.label`}
                render={({ field }) => (
                  <FormItem className="min-w-0 flex-1">
                    <FormLabel className="text-xs text-muted-foreground">
                      材料名称 <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如「营业执照照片」" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name={`stages.${stageIndex}.steps.${stepIndex}.materials.${materialIndex}.inputType`}
                render={({ field }) => (
                  <FormItem className="w-32">
                    <FormLabel className="text-xs text-muted-foreground">
                      类型
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {MATERIAL_TYPE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name={`stages.${stageIndex}.steps.${stepIndex}.materials.${materialIndex}.required`}
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-2 space-y-0 pb-2">
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <FormLabel className="font-normal text-sm">必填</FormLabel>
                  </FormItem>
                )}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mb-1"
                onClick={() => remove(materialIndex)}
              >
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
            <FormField
              control={control}
              name={`stages.${stageIndex}.steps.${stepIndex}.materials.${materialIndex}.helpText`}
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input placeholder="填写说明，如「照片四角完整」（选填）" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default TutorialAuthoringStepEditor;
