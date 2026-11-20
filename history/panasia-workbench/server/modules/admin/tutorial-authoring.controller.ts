import { Body, Controller, Get, Post } from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';

import { AdminTutorialCreateDto } from './admin.dto';
import { TutorialAuthoringService } from './tutorial-authoring.service';
import type {
  TutorialAuthoringCreateResponse,
  TutorialAuthoringListResponse,
} from '@shared/api.interface';

@Controller('api/admin/tutorial-authoring')
export class TutorialAuthoringController {
  constructor(private readonly tutorialAuthoring: TutorialAuthoringService) {}

  @Get()
  @CanRole(['boss', 'admin'])
  list(): Promise<TutorialAuthoringListResponse> {
    return this.tutorialAuthoring.listProjects();
  }

  @Post()
  @CanRole(['boss', 'admin'])
  create(
    @Body() dto: AdminTutorialCreateDto,
  ): Promise<TutorialAuthoringCreateResponse> {
    return this.tutorialAuthoring.createProject(dto);
  }
}
