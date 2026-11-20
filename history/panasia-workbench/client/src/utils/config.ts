/** 一期 Demo 演示开关：改为 true 可回到占位演示模式 */
export const DEMO_MODE = false;

/** 公司文件网关（2026-10-02 部署于京东云 wb-files.service，反代 Caddy /wb-files）：文件存阿里云 OSS panasia-plane-prod-20260919 桶 workbench/ 前缀，下载走 302 实时签名，URL 长期有效 */
export const WORKBENCH_FILES_BASE = 'http://127.0.0.1:8000';

// 上传不再从浏览器直连网关：走工作台服务端 POST /api/files/upload，口令只在服务端（WORKBENCH_UPLOAD_TOKEN）。
