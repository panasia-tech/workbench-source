import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';
import { WORKBENCH_FILES_BASE } from '@client/src/utils/config';

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i;
const NON_IMAGE_EXT_RE =
  /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar|7z|mp4|mov|avi|mkv|mp3|wav|m4a|aac)(\?|$)/i;

// 带图片扩展名按图片渲染；wb-files 无扩展名 URL 兜底试渲染（onError 回退），
// 已知文档/媒体扩展名直接文件块，避免 img 解码必然失败产生资源加载错误
function tryAsImage(url: string): boolean {
  if (IMAGE_EXT_RE.test(url)) return true;
  return url.startsWith(WORKBENCH_FILES_BASE) && !NON_IMAGE_EXT_RE.test(url);
}

interface EvidenceThumbnailsProps {
  urls: string[];
  label: string;
}

/** 凭证缩略图：图片点击应用内放大预览；非图片显示文件块，不外露 URL 文字 */
const EvidenceThumbnails: React.FC<EvidenceThumbnailsProps> = ({
  urls,
  label,
}) => {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const imageUrls: string[] = urls.filter(
    (url: string) => tryAsImage(url) && !failed[url],
  );

  const markFailed = (url: string) => {
    setFailed((prev: Record<string, boolean>) => ({ ...prev, [url]: true }));
  };

  const step = (delta: number) => {
    setPreviewIndex((prev: number | null) => {
      if (prev === null || imageUrls.length === 0) return prev;
      return (prev + delta + imageUrls.length) % imageUrls.length;
    });
  };

  return (
    <div className="flex flex-wrap gap-2">
      {urls.map((url: string) => {
        if (tryAsImage(url) && !failed[url]) {
          return (
            <button
              key={url}
              type="button"
              onClick={() =>
                setPreviewIndex(
                  imageUrls.findIndex((candidate: string) => candidate === url),
                )
              }
              className="block overflow-hidden rounded-md border transition-opacity hover:opacity-80"
            >
              <Image
                src={url}
                alt={label}
                width={56}
                height={56}
                className="h-14 w-14 object-cover"
                onError={() => markFailed(url)}
              />
            </button>
          );
        }
        return (
          <UniversalLink
            key={url}
            to={url}
            target="_blank"
            rel="noreferrer"
            className="flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-md border bg-muted/50 text-muted-foreground transition-colors hover:bg-muted"
          >
            <FileText className="h-5 w-5" />
            <span className="text-[10px] leading-none">文件</span>
          </UniversalLink>
        );
      })}

      <Dialog
        open={previewIndex !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setPreviewIndex(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate">{label}</DialogTitle>
          </DialogHeader>
          <div className="relative flex items-center justify-center">
            {previewIndex !== null && imageUrls[previewIndex] !== undefined && (
              <Image
                src={imageUrls[previewIndex]}
                alt={label}
                className="max-h-[70vh] w-auto rounded-lg object-contain"
              />
            )}
            {imageUrls.length > 1 && (
              <>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="上一张"
                  className="absolute left-0 top-1/2 -translate-y-1/2 rounded-full"
                  onClick={() => step(-1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="下一张"
                  className="absolute right-0 top-1/2 -translate-y-1/2 rounded-full"
                  onClick={() => step(1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
          {imageUrls.length > 1 && previewIndex !== null && (
            <p className="text-center text-xs text-muted-foreground">
              {previewIndex + 1} / {imageUrls.length}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default EvidenceThumbnails;
