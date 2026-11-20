import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { CallbackDataParams } from 'echarts/types/dist/shared';
import type { PerformanceCycle } from '@shared/api.interface';

interface PerformanceTrendChartProps {
  cycles: PerformanceCycle[];
  selectedId: string | null;
}

const PerformanceTrendChart = ({
  cycles,
  selectedId,
}: PerformanceTrendChartProps) => {
  const selected = cycles.find((c: PerformanceCycle) => c.id === selectedId);

  const option: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      formatter: (params: CallbackDataParams | CallbackDataParams[]) => {
        const list = Array.isArray(params) ? params : [params];
        const p = list[0];
        return `${p.name} 周期<br/>得分：${p.value ?? '暂无'}`;
      },
    },
    grid: { left: '3%', right: '6%', top: '14%', bottom: '20%', containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: true,
      data: cycles.map((c: PerformanceCycle) => c.name),
    },
    yAxis: { type: 'value', min: 0, max: 100 },
    series: [
      {
        type: 'line',
        data: cycles.map((c: PerformanceCycle) => c.score ?? null),
        symbolSize: 9,
        connectNulls: false,
        label: {
          show: true,
          formatter: (p: CallbackDataParams) => `${p.value ?? '—'}`,
        },
        areaStyle: { opacity: 0.08 },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [
            {
              yAxis: 80,
              lineStyle: { type: 'dashed', color: '#f59e0b' },
              label: { formatter: '良好线 80', position: 'insideEndTop' },
            },
            {
              yAxis: 90,
              lineStyle: { type: 'dashed', color: '#16a34a' },
              label: { formatter: '优秀线 90', position: 'insideEndTop' },
            },
          ],
        },
        markPoint: selected?.score
          ? {
              data: [{ name: '当前查看', coord: [selected.name, selected.score] }],
            }
          : undefined,
      },
    ],
  };

  return <ReactECharts option={option} theme="ud" className="h-[300px]" />;
};

export default PerformanceTrendChart;
