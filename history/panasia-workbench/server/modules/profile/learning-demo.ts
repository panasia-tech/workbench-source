import type { MyLearning } from '@shared/api.interface';

// LMS Course 在本环境不可创建（Member DocType 损坏，ImportError）
// 学习中心数据降级为服务端演示数据，仅在绑定的 Frappe 员工存在时返回（wipe 后自动为空）
export const DEMO_LEARNING: MyLearning = {
  requiredTotal: 2,
  requiredDone: 2,
  courses: [
    {
      id: 'DEMO-REQUIRED-01',
      title: '采购岗位入门',
      category: 'required',
      progress: 100,
      completedAt: '2026-06-18',
    },
    {
      id: 'DEMO-REQUIRED-02',
      title: '商品验货基础',
      category: 'required',
      progress: 100,
      completedAt: '2026-09-12',
    },
    {
      id: 'DEMO-TUTORIAL-01',
      title: '扫地机器人验货教程',
      category: 'tutorial',
      progress: 70,
      completedAt: null,
    },
    {
      id: 'DEMO-ADVANCED-01',
      title: '采购议价进阶',
      category: 'advanced',
      progress: 0,
      completedAt: null,
    },
    {
      id: 'DEMO-SHORT-01',
      title: '商品图片验收规范',
      category: null,
      progress: 100,
      completedAt: '2026-08-05',
    },
  ],
  exams: [
    { id: 'DEMO-EXAM-01', title: '采购岗位基础考试', score: 92, passed: true, examDate: '2026-09-15' },
    { id: 'DEMO-EXAM-02', title: '商品验货考试', score: 88, passed: true, examDate: '2026-09-22' },
  ],
  averageScore: 90,
};
