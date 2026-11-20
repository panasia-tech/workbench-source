import { Module } from '@nestjs/common';

import { ProblemsModule } from '../problems/problems.module';
import { ProfileModule } from '../profile/profile.module';
import { AdminController } from './admin.controller';
import { AdminManageController } from './admin-manage.controller';
import { AuditLogController } from './audit-log.controller';
import { EmployeeBindingController } from './employee-binding.controller';
import { TutorialAuthoringController } from './tutorial-authoring.controller';
import { TutorialCasesController } from './tutorial-cases.controller';
import { AdminService } from './admin.service';
import { AdminManageService } from './admin-manage.service';
import { QuickTaskDraftService } from './quick-task-draft.service';
import { EmployeeBindingService } from './employee-binding.service';
import { TutorialAuthoringService } from './tutorial-authoring.service';

@Module({
  // ProfileModule：教程内容（Learning 读写）与分配教程
  imports: [ProblemsModule, ProfileModule],
  controllers: [
    AdminController,
    AdminManageController,
    AuditLogController,
    EmployeeBindingController,
    TutorialAuthoringController,
    TutorialCasesController,
  ],
  providers: [
    AdminService,
    AdminManageService,
    QuickTaskDraftService,
    EmployeeBindingService,
    TutorialAuthoringService,
  ],
})
export class AdminModule {}
