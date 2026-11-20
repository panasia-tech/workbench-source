import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { ProfileService } from './profile.service';
import { TutorialCaseService } from './tutorial-case.service';
import { TutorialSkipService } from './tutorial-skip.service';
import { MyHrService } from './my-hr.service';
import { MediaCatalogService } from './media-catalog.service';
import { DemoViewService } from '../demo/demo-view.service';
import {
  SubmitTutorialStepDto,
  UpdateBindingDto,
} from './profile.dto';
import { SubmitTutorialSkipDto } from './tutorial-skip.dto';
import { STEP_KEY_PATTERN } from './tutorial-lesson-body';
import type {
  BindingOptionsResponse,
  EmployeeBinding,
  MyAttendance,
  MyContract,
  MyLeaveApplicationsResponse,
  MyLearning,
  MyLearningVideos,
  MyOverview,
  MySalary,
  MySalarySlipsResponse,
  MyTutorialSkipListResponse,
  SalarySlipDetail,
  SubmitTutorialStepResponse,
  TutorialCaseDetail,
  TutorialSkipRequestInfo,
} from '@shared/api.interface';

@Controller('api/my')
export class ProfileController {
  constructor(
    private readonly profileService: ProfileService,
    private readonly tutorialCaseService: TutorialCaseService,
    private readonly tutorialSkipService: TutorialSkipService,
    private readonly myHrService: MyHrService,
    private readonly mediaCatalog: MediaCatalogService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get()
  async getMyOverview(@Req() req: Request): Promise<MyOverview> {
    const view = await this.demoView.resolve(req);
    const overview = await this.profileService.getMyOverview(
      view.userId,
      view.userName,
    );
    return { ...overview, canEditBinding: this.canEditBinding(req) };
  }

  @NeedLogin()
  @Get('binding-options')
  getBindingOptions(): Promise<BindingOptionsResponse> {
    return this.profileService.getBindingOptions();
  }

  @NeedLogin()
  @Get('salary')
  async getMySalary(@Req() req: Request): Promise<MySalary> {
    const view = await this.demoView.resolve(req);
    return this.profileService.getMySalary(view.userId);
  }

  @NeedLogin()
  @Get('contract')
  async getMyContract(@Req() req: Request): Promise<MyContract> {
    const view = await this.demoView.resolve(req);
    return this.profileService.getMyContract(view.userId);
  }

  @NeedLogin()
  @Get('attendance')
  async getMyAttendance(@Req() req: Request): Promise<MyAttendance> {
    const view = await this.demoView.resolve(req);
    return this.profileService.getMyAttendance(view.userId);
  }

  @NeedLogin()
  @Get('salary-slips')
  async getMySalarySlips(
    @Req() req: Request,
  ): Promise<MySalarySlipsResponse> {
    const view = await this.demoView.resolve(req);
    return this.myHrService.getMySalarySlips(view.userId);
  }

  @NeedLogin()
  @Get('salary-slips/:name')
  async getMySalarySlipDetail(
    @Req() req: Request,
    @Param('name') name: string,
  ): Promise<SalarySlipDetail> {
    const view = await this.demoView.resolve(req);
    return this.myHrService.getMySalarySlipDetail(
      view.userId,
      decodeURIComponent(name),
    );
  }

  @NeedLogin()
  @Get('leave-applications')
  async getMyLeaveApplications(
    @Req() req: Request,
  ): Promise<MyLeaveApplicationsResponse> {
    const view = await this.demoView.resolve(req);
    return this.myHrService.getMyLeaveApplications(view.userId);
  }

  @NeedLogin()
  @Get('learning')
  async getMyLearning(@Req() req: Request): Promise<MyLearning> {
    const view = await this.demoView.resolve(req);
    return this.profileService.getMyLearning(view.userId);
  }

  @NeedLogin()
  @Get('learning/videos')
  async getMyLearningVideos(@Req() req: Request): Promise<MyLearningVideos> {
    const view = await this.demoView.resolve(req);
    return this.mediaCatalog.getVideos(view.userId);
  }

  @NeedLogin()
  @Get('learning/case/:caseId')
  async getTutorialCase(
    @Req() req: Request,
    @Param('caseId') caseId: string,
  ): Promise<TutorialCaseDetail> {
    const id = Number(caseId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('案例 ID 非法');
    }
    const view = await this.demoView.resolve(req);
    return this.tutorialCaseService.getTutorialCaseDetail(
      view.userId,
      id,
    );
  }

  @NeedLogin()
  @Post('learning/case/:caseId/steps/:stepId/submit')
  async submitTutorialStep(
    @Req() req: Request,
    @Param('caseId') caseId: string,
    @Param('stepId') stepId: string,
    @Body() dto: SubmitTutorialStepDto,
  ): Promise<SubmitTutorialStepResponse> {
    const caseNum = Number(caseId);
    if (!Number.isInteger(caseNum) || caseNum <= 0) {
      throw new BadRequestException('案例 ID 非法');
    }
    // 步骤 ID = Learning 课时的 pa_step_key（10-19 起，以前是 NocoBase 数字 ID）
    if (!STEP_KEY_PATTERN.test(stepId)) {
      throw new BadRequestException('步骤 ID 非法');
    }
    const view = await this.demoView.resolve(req);
    return this.tutorialCaseService.submitTutorialStep(
      view.userId,
      caseNum,
      stepId,
      dto,
    );
  }

  @NeedLogin()
  @Post('learning/case/:caseId/steps/:stepId/skip-request')
  async submitTutorialSkipRequest(
    @Req() req: Request,
    @Param('caseId') caseId: string,
    @Param('stepId') stepId: string,
    @Body() dto: SubmitTutorialSkipDto,
  ): Promise<TutorialSkipRequestInfo> {
    const caseNum = Number(caseId);
    if (!Number.isInteger(caseNum) || caseNum <= 0) {
      throw new BadRequestException('案例 ID 非法');
    }
    if (!STEP_KEY_PATTERN.test(stepId)) {
      throw new BadRequestException('步骤 ID 非法');
    }
    const view = await this.demoView.resolve(req);
    return this.tutorialSkipService.submitSkipRequest(
      view.userId,
      caseNum,
      stepId,
      dto.reason,
    );
  }

  @NeedLogin()
  @Get('learning/skip-requests')
  async listMySkipRequests(
    @Req() req: Request,
  ): Promise<MyTutorialSkipListResponse> {
    const view = await this.demoView.resolve(req);
    return this.tutorialSkipService.listByUser(view.userId);
  }

  @NeedLogin()
  @Put('binding')
  async updateBinding(
    @Req() req: Request,
    @Body() dto: UpdateBindingDto,
  ): Promise<EmployeeBinding> {
    // 绑定决定能看谁的工资条和绩效：员工不能自己改，由 boss/admin 在这里或管理端「员工」里设置
    if (!this.canEditBinding(req)) {
      throw new ForbiddenException(
        '岗位和成员绑定由管理员设置，需要改请联系管理员',
      );
    }
    const view = await this.demoView.resolve(req);
    return this.profileService.updateBinding(view.userId, dto);
  }

  private canEditBinding(req: Request): boolean {
    const roles: string[] = req.userContext.roles ?? [];
    return roles.includes('boss') || roles.includes('admin');
  }
}
