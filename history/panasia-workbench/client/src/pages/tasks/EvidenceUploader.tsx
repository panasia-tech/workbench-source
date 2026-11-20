import { useEffect, useRef, useState } from 'react';
import {
  File,
  FileAudio,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Loader2,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { toast } from 'sonner';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { Image } from '@/components/ui/image';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { WORKBENCH_FILES_BASE } from '@client/src/utils/config';
import { uploadToWorkbench } from '@client/src/utils/upload-to-workbench';

export interface EvidenceFile {
  name: string;
  size: number;
  url: string;
}

interface FileMetaResponse {
  size?: number;
}

function metaUrlFor(url: string): string | null {
  const prefix = `${WORKBENCH_FILES_BASE}/files/`;
  if (!url.startsWith(prefix)) return null;
  return `${url}/meta`;
}

function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name.toLowerCase());
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(name: string) {
  const lower = name.toLowerCase();
  if (isImageName(lower)) return ImageIcon;
  if (/\.(mp4|mov|avi|mkv|webm)$/.test(lower)) return FileVideo;
  if (/\.(mp3|wav|m4a|aac|ogg|amr)$/.test(lower)) return FileAudio;
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/.test(lower)) return FileText;
  return File;
}

interface EvidenceUploaderProps {
  files: EvidenceFile[];
  onChange: (files: EvidenceFile[]) => void;
}

export function EvidenceUploader({ files, onChange }: EvidenceUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sizeOverrides, setSizeOverrides] = useState<Record<string, number>>({});

  useEffect(() => {
    const pendingFetch = files.filter(
      (f: EvidenceFile) =>
        f.size === 0 && sizeOverrides[f.url] === undefined && metaUrlFor(f.url),
    );
    if (pendingFetch.length === 0) return;
    let cancelled = false;
    void Promise.all(
      pendingFetch.map(async (f: EvidenceFile): Promise<void> => {
        try {
          const res = await fetch(metaUrlFor(f.url) as string);
          if (!res.ok) return;
          const data = (await res.json()) as FileMetaResponse;
          if (!cancelled && typeof data.size === 'number' && data.size > 0) {
            setSizeOverrides((prev: Record<string, number>) => ({
              ...prev,
              [f.url]: data.size,
            }));
          }
        } catch {
          logger.warn('凭证文件大小获取失败', { url: f.url });
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [files, sizeOverrides]);

  const uploadFiles = async (list: FileList | File[]) => {
    const added: EvidenceFile[] = [];
    const pending: File[] = Array.from(list);
    for (const file of pending) {
      setUploadingName(file.name);
      try {
        added.push(await uploadToWorkbench(file));
      } catch (err: unknown) {
        logger.error('凭证上传失败', { file: file.name, err });
        toast.error(`${file.name} 上传失败，请重试`);
      } finally {
        setUploadingName(null);
      }
    }
    if (added.length > 0) onChange([...files, ...added]);
  };

  const removeFile = (url: string) => {
    logger.info('凭证移除（OSS 原件保留备查）', { url });
    onChange(files.filter((f: EvidenceFile) => f.url !== url));
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
        className="hidden"
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          if (e.target.files?.length) void uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e: React.DragEvent<HTMLButtonElement>) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e: React.DragEvent<HTMLButtonElement>) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
        }}
        disabled={uploadingName !== null}
        className={`flex w-full flex-col items-center gap-1 rounded-lg border border-dashed p-5 text-center transition-colors ${
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border bg-muted/30 hover:bg-muted/60'
        }`}
      >
        <UploadCloud className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">
          {uploadingName !== null ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {`正在上传 ${uploadingName}`}
            </span>
          ) : (
            '点击或拖拽上传凭证'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          支持截图 / 聊天记录截图 / 录音 / 视频 / 文档（PDF、Word、Excel 等）
        </p>
      </button>
      {files.length > 0 ? (
        <ul className="space-y-1.5">
          {files.map((file: EvidenceFile) => {
            const Icon = iconFor(file.name);
            const size = sizeOverrides[file.url] ?? file.size;
            return (
              <li
                key={file.url}
                className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
              >
                {isImageName(file.name) ? (
                  <button
                    type="button"
                    onClick={() => setPreviewUrl(file.url)}
                    className="shrink-0 overflow-hidden rounded"
                  >
                    <Image
                      src={file.url}
                      alt={file.name}
                      width={40}
                      height={40}
                      className="h-10 w-10 object-cover"
                    />
                  </button>
                ) : (
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatSize(size)}
                </span>
                <button
                  type="button"
                  onClick={() => removeFile(file.url)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Dialog
        open={previewUrl !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setPreviewUrl(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          {previewUrl !== null ? (
            <Image
              src={previewUrl}
              alt="预览"
              className="mx-auto max-h-[75vh] w-auto rounded-md"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
