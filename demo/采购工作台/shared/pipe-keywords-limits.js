/** 竖线/逗号分隔关键词：单段最长字符数 */
export const PIPE_KW_SEG_MAX_LEN = 120

/** 竖线/逗号分隔关键词：最多段数（包含/排除/卖家排除等共用） */
export const PIPE_KW_SEG_CAP = 80

/** 关键词整段字符串最大长度（写入任务/全局配置前截断） */
export const PIPE_KW_RAW_MAX_LEN = 1600

/**
 * 多词拆段：竖线、中英文逗号、顿号、分号、换行。
 * 商家名称过滤是 textarea，用户常按回车或用顿号，不能只认 | 和逗号。
 */
export const PIPE_SEGMENT_SPLIT_RE = /[|｜，,、；;\r\n]+/u
