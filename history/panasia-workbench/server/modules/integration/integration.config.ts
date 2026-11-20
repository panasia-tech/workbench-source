import { existsSync } from 'fs';
import { join } from 'path';
import { config as loadDotenv } from 'dotenv';

const envLocalPath = join(process.cwd(), '.env.local');
if (existsSync(envLocalPath)) {
  loadDotenv({ path: envLocalPath });
}

export const integrationConfig = {
  planeBaseUrl: process.env.PLANE_BASE_URL ?? 'http://127.0.0.1:8000',
  planeApiKey: process.env.PLANE_API_KEY ?? '',
  planeWorkspaceSlug: process.env.PLANE_WORKSPACE_SLUG ?? 'panasia',
  frappeBaseUrl: process.env.FRAPPE_BASE_URL ?? 'http://127.0.0.1:8000',
  frappeApiKey: process.env.FRAPPE_API_KEY ?? '',
  frappeApiSecret: process.env.FRAPPE_API_SECRET ?? '',
  ailyAppId: process.env.AILY_APP_ID ?? 'cli_aaed8f10a638dbd5',
  ailyAppSecret: process.env.AILY_APP_SECRET ?? '',
};

export function getFrappeSiteUrl(): string {
  return integrationConfig.frappeBaseUrl.replace(/\/api\/?$/, '');
}

/** Learning（Frappe LMS，和 HR 同一站点）前台地址；传课程 name 给课程页 */
export function getLearningUrl(course?: string): string {
  const base = `${getFrappeSiteUrl()}/lms`;
  return course ? `${base}/courses/${encodeURIComponent(course)}` : base;
}
