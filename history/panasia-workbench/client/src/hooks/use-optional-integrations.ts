import { useEffect, useState } from 'react';

import type { OptionalIntegrations } from '@shared/api.interface';
import { fetchOptionalIntegrations } from '@client/src/api/integrations';

// 开关改了要重启服务端，页面生命周期内取一次就够；各组件共用同一个请求
let cached: Promise<OptionalIntegrations> | null = null;

/**
 * 飞书 / 豆包可选集成开了哪些。加载完成前返回 null：
 * 调用方按「没开」渲染（只隐藏、不报错），加载完再按真实开关补上。
 */
export function useOptionalIntegrations(): OptionalIntegrations | null {
  const [value, setValue] = useState<OptionalIntegrations | null>(null);

  useEffect(() => {
    let cancelled = false;
    cached ??= fetchOptionalIntegrations();
    void cached.then((result: OptionalIntegrations) => {
      if (!cancelled) setValue(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return value;
}
