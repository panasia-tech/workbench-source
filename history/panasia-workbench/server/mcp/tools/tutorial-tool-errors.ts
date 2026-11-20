import { ConflictException, NotFoundException } from '@nestjs/common';
import { McpToolError } from '@lark-apaas/fullstack-nestjs-core';
import { TutorialContentUnavailableError } from '@server/modules/profile/tutorial-content.service';

/**
 * tutorial_* 工具统一的报错口径：Learning 读写失败、别人刚改过、对象不存在都转成带 code 的 McpToolError，
 * 豆包按 code 走 skill 里写的处理（重新查 / 稍后再试 / 找程序员），不吐 500 原文
 */
export async function runTutorialTool<T>(
  notFoundCode: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    if (error instanceof TutorialContentUnavailableError) {
      throw new McpToolError(
        `Learning 暂时读写不了，稍后再试（${error.detail}）`,
        { code: 'LEARNING_UNAVAILABLE' },
      );
    }
    if (error instanceof ConflictException) {
      throw new McpToolError(
        `${error.message}；先用 tutorial_list_form_fields / tutorial_list_steps 重新查一遍再改`,
        { code: 'CONFLICT' },
      );
    }
    if (error instanceof NotFoundException) {
      throw new McpToolError(
        `${error.message}，先用 tutorial_list_steps 查有效 ID`,
        { code: notFoundCode },
      );
    }
    throw error;
  }
}
