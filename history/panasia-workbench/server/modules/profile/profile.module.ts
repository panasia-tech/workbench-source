import { Module } from '@nestjs/common';
import { PerformanceModule } from '../performance/performance.module';
import { DemoModule } from '../demo/demo.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { TutorialCaseService } from './tutorial-case.service';
import { TutorialSkipService } from './tutorial-skip.service';
import { TutorialSkipAdminController } from './tutorial-skip-admin.controller';
import { TutorialReviewController } from './tutorial-review.controller';
import { TutorialReviewService } from './tutorial-review.service';
import { MyHrService } from './my-hr.service';
import { TutorialOutputService } from './tutorial-output.service';
import { TutorialContentService } from './tutorial-content.service';
import { TutorialAssignService } from './tutorial-assign.service';
import { MediaCatalogService } from './media-catalog.service';
import { TutorialAdminMcpTools } from '@server/mcp/tools/tutorial-admin.tools';
import { TutorialAuthoringMcpTools } from '@server/mcp/tools/tutorial-authoring.tools';

@Module({
  imports: [PerformanceModule, DemoModule],
  controllers: [
    ProfileController,
    TutorialReviewController,
    TutorialSkipAdminController,
  ],
  providers: [
    ProfileService,
    TutorialContentService,
    TutorialCaseService,
    TutorialAssignService,
    MediaCatalogService,
    TutorialSkipService,
    TutorialReviewService,
    MyHrService,
    TutorialOutputService,
    TutorialAdminMcpTools,
    TutorialAuthoringMcpTools,
  ],
  // 管理端「教程模板」编写、分配教程也走这里的 Learning 读写（AdminModule 引入）
  exports: [
    ProfileService,
    TutorialOutputService,
    TutorialContentService,
    TutorialAssignService,
  ],
})
export class ProfileModule {}
