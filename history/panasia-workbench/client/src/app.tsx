import React from 'react';
import { Route, Routes } from 'react-router-dom';

import { installBackendErrorGuard } from './utils/backend-error-guard';
import { installDemoViewInterceptor } from './utils/demo-view';

import Layout from './components/Layout';
import TasksPage from './pages/tasks/TasksPage';
import TaskDetailPage from './pages/tasks/TaskDetailPage';
import ProjectsPage from './pages/projects/ProjectsPage';
import ProjectDetailPage from './pages/projects/ProjectDetailPage';
import WorkPage from './pages/work/WorkPage';
import PerformancePage from './pages/performance/PerformancePage';
import MyPage from './pages/my/MyPage';
import SalaryPage from './pages/my/SalaryPage';
import ContractPage from './pages/my/ContractPage';
import AttendancePage from './pages/my/AttendancePage';
import LearningPage from './pages/my/LearningPage';
import SalarySlipsPage from './pages/my/SalarySlipsPage';
import ErpPayslipPage from './pages/my/ErpPayslipPage';
import LeavePage from './pages/my/LeavePage';
import TutorialCaseDetailPage from './pages/my/TutorialCaseDetailPage';
import TaskHistoryPage from './pages/my/TaskHistoryPage';
import MyBlockersPage from './pages/my/MyBlockersPage';
import HostedCustomersPage from './pages/my/HostedCustomersPage';
import TutorialSkipRequestsPage from './pages/my/TutorialSkipRequestsPage';
import DevRequestsPage from './pages/dev-requests/DevRequestsPage';
import DevRequestNewPage from './pages/dev-requests/DevRequestNewPage';
import DevRequestDetailPage from './pages/dev-requests/DevRequestDetailPage';
import AdminLayout from './pages/admin/AdminLayout';
import AdminOverviewPage from './pages/admin/AdminOverviewPage';
import AdminExecutePage from './pages/admin/AdminExecutePage';
import AdminMemberDetailPage from './pages/admin/AdminMemberDetailPage';
import AdminDayActivityPage from './pages/admin/AdminDayActivityPage';
import AdminProblemsPage from './pages/admin/AdminProblemsPage';
import AdminReviewPage from './pages/admin/AdminReviewPage';
import AdminManagePage from './pages/admin/AdminManagePage';
import AdminErpStatsPage from './pages/admin/AdminErpStatsPage';
import LoginPage from './pages/login/LoginPage';
import NotFound from './pages/NotFound/NotFound';

installDemoViewInterceptor();
installBackendErrorGuard();

const RoutesComponent = () => {
  return (
    <Routes>
      {/* 独立部署的登录页（统一账号 / 本机开发登录），接口 401 时跳到这里 */}
      <Route path="login" element={<LoginPage />} />
      <Route element={<Layout />}>
        <Route index element={<TasksPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="tasks/:taskId" element={<TaskDetailPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="work" element={<WorkPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="my" element={<MyPage />} />
        <Route path="my/salary" element={<SalaryPage />} />
        <Route path="my/contract" element={<ContractPage />} />
        <Route path="my/attendance" element={<AttendancePage />} />
        <Route path="my/learning" element={<LearningPage />} />
        <Route path="my/salary-slips" element={<SalarySlipsPage />} />
        <Route path="my/erp-payslip" element={<ErpPayslipPage />} />
        <Route path="my/leave" element={<LeavePage />} />
        <Route
          path="my/learning/case/:caseId"
          element={<TutorialCaseDetailPage />}
        />
        <Route path="my/hosted-customers" element={<HostedCustomersPage />} />
        <Route path="my/tutorial-skips" element={<TutorialSkipRequestsPage />} />
        <Route path="my/history" element={<TaskHistoryPage />} />
        <Route path="my/blockers" element={<MyBlockersPage />} />
        <Route path="dev-requests" element={<DevRequestsPage />} />
        <Route path="dev-requests/new" element={<DevRequestNewPage />} />
        <Route path="dev-requests/:id" element={<DevRequestDetailPage />} />
      </Route>
      <Route element={<AdminLayout />}>
        <Route path="admin" element={<AdminOverviewPage />} />
        <Route path="admin/execute" element={<AdminExecutePage />} />
        <Route path="admin/execute/day" element={<AdminDayActivityPage />} />
        <Route
          path="admin/execute/:userId"
          element={<AdminMemberDetailPage />}
        />
        <Route path="admin/problems" element={<AdminProblemsPage />} />
        <Route path="admin/review" element={<AdminReviewPage />} />
        <Route path="admin/manage" element={<AdminManagePage />} />
        <Route path="admin/erp-stats" element={<AdminErpStatsPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default RoutesComponent;
