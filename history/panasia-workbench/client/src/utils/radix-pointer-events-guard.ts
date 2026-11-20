import { logger } from '@lark-apaas/client-toolkit/logger';

const OVERLAY_SELECTORS = [
  '[data-radix-popper-content-wrapper]',
  '[role="dialog"]',
  '[data-state="open"][data-radix-menu-content]',
];

function hasOpenOverlay(): boolean {
  return OVERLAY_SELECTORS.some((selector: string) =>
    Boolean(document.querySelector(selector))
  );
}

export function clearStalePointerEvents(reason: string): void {
  const body = document.body;
  if (body.style.pointerEvents === 'none' && !hasOpenOverlay()) {
    body.style.pointerEvents = '';
    logger.info(`已清理 body pointer-events 残留（${reason}）`);
  }
}

export function installRadixPointerEventsGuard(): () => void {
  const body = document.body;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const check = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (body.style.pointerEvents === 'none' && !hasOpenOverlay()) {
        body.style.pointerEvents = '';
        logger.info('已自愈 body pointer-events 残留');
      }
    }, 600);
  };

  const observer = new MutationObserver((mutations: MutationRecord[]) => {
    const touched = mutations.some(
      (m: MutationRecord) =>
        m.type === 'attributes' &&
        m.attributeName === 'style' &&
        m.target === body
    );
    if (touched) check();
  });

  observer.observe(body, { attributes: true, attributeFilter: ['style'] });
  clearStalePointerEvents('布局挂载');

  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}
