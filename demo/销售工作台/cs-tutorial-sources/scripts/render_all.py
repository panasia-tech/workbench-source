#!/usr/bin/env python3
# 渲染教程模板（带全机 6 槽 Chrome 并发锁 /tmp/panasia_chrome_slot_{0..5}.lock，防 5 个会话同时炸内存）
# 用法：
#   1) 复制到自己工程的 scripts/render_all.py，修改 PROJECT_SLUG 与 NAMES，或
#   2) PROJECT_SLUG=cs_remake NAMES_JSON=../project/names.json python3 render_all.py [cut ...] [--jobs 3] [--fps 30]
import fcntl, json, os, re, subprocess, sys, time

ES = os.path.expanduser('~/explainer-studio')
FF = f'{ES}/.bin/ffmpeg'
FP = f'{ES}/.bin/ffprobe'
HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(HERE + '/../project')
DEL = os.path.normpath(HERE + '/../交付')

PROJECT_SLUG = os.environ.get('PROJECT_SLUG', 'CHANGE_ME_SLUG')
# NAMES 格式: { cut: (num_prefix, title, node_id) }
NAMES = {
    # 'cut1': ('01', '节点名称', 'NODE-01'),
}
if os.environ.get('NAMES_JSON') and os.path.exists(os.environ['NAMES_JSON']):
    raw_names = json.load(open(os.environ['NAMES_JSON'], encoding='utf-8'))
    NAMES = {k: tuple(v) for k, v in raw_names.items()}
elif not NAMES and os.path.exists(f'{PROJ}/names.json'):
    raw_names = json.load(open(f'{PROJ}/names.json', encoding='utf-8'))
    NAMES = {k: tuple(v) for k, v in raw_names.items()}

if PROJECT_SLUG == 'CHANGE_ME_SLUG' or not NAMES:
    sys.exit('请先设置 PROJECT_SLUG 与 NAMES（或提供 project/names.json / NAMES_JSON）')

args = sys.argv[1:]
jobs = int(args[args.index('--jobs') + 1]) if '--jobs' in args else 3
fps = int(args[args.index('--fps') + 1]) if '--fps' in args else 30
cuts = [a for a in args if a in NAMES] or list(NAMES)
os.makedirs(DEL, exist_ok=True)

MAX_GLOBAL_SLOTS = 6
def try_acquire_chrome_slot():
    for s in range(MAX_GLOBAL_SLOTS):
        lock_path = f'/tmp/panasia_chrome_slot_{s}.lock'
        fd = open(lock_path, 'a+')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return s, fd
        except BlockingIOError:
            fd.close()
    return None, None

plan = []
for c in cuts:
    lay = json.load(open(f'{PROJ}/vo/{c}/layout.json', encoding='utf-8'))
    dur = lay['duration'] + 0.5
    n = max(1, round(dur / 45))
    step = dur / n
    out = f'{ES}/out/{PROJECT_SLUG}/{c}'
    os.makedirs(f'{out}/seg', exist_ok=True)
    for i in range(n):
        a, b = round(i * step * fps) / fps, round(min(dur, (i + 1) * step) * fps) / fps
        plan.append((c, i, a, b, f'{out}/seg/s{i:02d}.mp4'))
    plan[-1] = (c, n - 1, plan[-1][2], round(dur * fps) / fps, plan[-1][4])

t0 = time.time()
todo = [p for p in plan if not os.path.exists(p[4])]
running = []  # (proc, cut, idx, out_mp4, slot_id, lock_fd)
print(f'{PROJECT_SLUG}: {len(plan)} segments, {len(todo)} to render, local_jobs={jobs}, global_chrome_slots={MAX_GLOBAL_SLOTS}', flush=True)

while todo or running:
    while todo and len(running) < jobs:
        slot_id, lock_fd = try_acquire_chrome_slot()
        if lock_fd is None:
            break
        c, i, a, b, f = todo.pop(0)
        p = subprocess.Popen(
            ['node', 'engine/render.mjs', 'video', f'{a:.6f}', f'{b:.6f}', str(fps),
             os.path.relpath(f + '.tmp.mp4', f'{ES}/out/{PROJECT_SLUG}/{c}'),
             '--project', PROJECT_SLUG, '--cut', c],
            cwd=ES, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, close_fds=True
        )
        running.append((p, c, i, f, slot_id, lock_fd))
    for r in list(running):
        p, c, i, f, slot_id, lock_fd = r
        if p.poll() is None:
            continue
        running.remove(r)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            lock_fd.close()
        if p.returncode == 0 and os.path.exists(f + '.tmp.mp4'):
            os.replace(f + '.tmp.mp4', f)
            print(f'ok {c} seg{i} (slot {slot_id})  {time.time() - t0:.0f}s', flush=True)
        else:
            print('FAIL', c, i, p.stderr.read().decode()[-300:], flush=True)
    time.sleep(0.5)

for c in cuts:
    out = f'{ES}/out/{PROJECT_SLUG}/{c}'
    segs = sorted(x for x in os.listdir(f'{out}/seg') if x.endswith('.mp4') and 'tmp' not in x)
    open(f'{out}/seg/list.txt', 'w').write(''.join(f"file '{s}'\n" for s in segs))
    subprocess.run([FF, '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', f'{out}/seg/list.txt', '-c', 'copy', f'{out}/video-silent.mp4'], check=True)
    raw = f'{PROJ}/vo/{c}/voiceover.wav'
    num, title, node = NAMES[c]
    log = subprocess.run([FF, '-nostats', '-i', raw, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    I = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', log)[-1])
    mp4 = f'{DEL}/{num}_{title}.mp4'
    subprocess.run([FF, '-v', 'error', '-y', '-i', f'{out}/video-silent.mp4', '-i', raw, '-map', '0:v', '-map', '1:a',
                    '-vf', 'scale=out_range=tv,format=yuv420p',
                    '-af', f'volume={-14.0 - I:.2f}dB,alimiter=limit=0.84:level=false',
                    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-tune', 'animation',
                    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', mp4], check=True)
    caps = json.loads(re.search(r'export const CAPTIONS = (\[.*\]);', open(f'{PROJ}/captions-{c}.js', encoding='utf-8').read(), re.S).group(1))
    ts = lambda t: f'{int(t * 1000) // 3600000:02d}:{int(t * 1000) // 60000 % 60:02d}:{int(t * 1000) // 1000 % 60:02d},{int(round(t * 1000)) % 1000:03d}'
    open(f'{DEL}/{num}_{title}_字幕.srt', 'w', encoding='utf-8').write(''.join(f'{i + 1}\n{ts(x["t0"])} --> {ts(x["t1"])}\n{x["text"]}\n\n' for i, x in enumerate(caps)))
    lay = json.load(open(f'{PROJ}/vo/{c}/layout.json', encoding='utf-8'))
    mm = lambda t: f'{int(t // 60)}:{int(t % 60):02d}'
    open(f'{DEL}/{num}_{title}_逐字稿.md', 'w', encoding='utf-8').write(
        f'# {title}（{node}）逐字稿\n\n全片 {mm(round(lay["duration"]))}，旁白 {len(lay["lines"])} 句。配音：千问 Qwen3-TTS 官方预置音色 Serena。\n\n' +
        ''.join(f'- `{mm(l["at"])}` {l["text"]}\n' for l in lay['lines'])
    )
    d = subprocess.run([FP, '-v', 'error', '-show_entries', 'format=duration,size', '-of', 'csv=p=0', mp4], capture_output=True, text=True).stdout.strip()
    print('DONE', mp4, d, flush=True)
