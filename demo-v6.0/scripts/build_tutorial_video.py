#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
泛亚采购工作台 × 闲鱼监控助手 v6.0 内置教学视频合成器
输入：7张真实 v6.0 Web GUI 截图 + 贺育诚原声 (--voice serious)
输出：1280x720 手绘批注风格讲解视频 public/media/tutorial-v6.mp4 + 章节时间戳 JSON
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SHOT_DIR = Path('/Users/user/.gemini/antigravity/brain/7623f598-2dd7-4f5d-b785-8423c1a7427c/browser_sandbox/screenshots')
OUT_DIR = ROOT / 'public' / 'media'
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_MP4 = OUT_DIR / 'tutorial-v6.mp4'
OUT_META = OUT_DIR / 'tutorial_chapters.json'

TTS_SH = '/Users/user/VoiceTTS/tts.sh'
FFMPEG = '/opt/homebrew/bin/ffmpeg'
FFPROBE = '/opt/homebrew/bin/ffprobe'

FONT_BOLD = '/System/Library/Fonts/STHeiti Medium.ttc'
FONT_LIGHT = '/System/Library/Fonts/STHeiti Light.ttc'


def load_font(path, size):
    return ImageFont.truetype(path, size=size)


CHAPTERS = [
    {
        'id': 'ch1',
        'title': '第1章 · 真实登录与新手 3 关防踩坑保护',
        'shot': SHOT_DIR / 'step_4_shot_1_shot1_login.png',
        'badge': '真实 scrypt + JWT · 429 防爆破 · 403 新手锁',
        'subtitle': '先用实名账号登录；未通关 3 道防踩坑练习前，新采购员写入操作全部 403 硬拦截。',
        'callouts': [
            '1. 每人独立账号密码（连续错5次触发429锁定）',
            '2. newbie 未过3关测试前禁止建监控/付款/转单',
            '3. 进「视频教程与3关考试」1分钟即可答题解锁',
        ],
        'highlight_box': (435, 165, 865, 480),  # relative on scaled UI preview
        'arrow_from': (932, 315),
        'arrow_to': (870, 315),
        'narration': (
            '欢迎使用泛亚采购工作台与闲鱼监控融合第六版。为了杜绝误操作和代点签收，'
            '系统全部采用真实账号加密登录。新入职采购员登录后如果还没通过三关防踩坑练习，'
            '新建监控、发消息或登记付款都会被四零三自动锁住，只需花一分钟在教程中心答对三题即可立刻解锁。'
        ),
    },
    {
        'id': 'ch2',
        'title': '第2章 · 闲鱼监控融合与行情上限防买贵(403)',
        'shot': SHOT_DIR / 'step_18_shot_1_step_shot4_monitor_tasks.png',
        'badge': '全域监听 · areas.json 省市 · 403 天花板锁',
        'subtitle': '监听绑定《四维行情参考表》SKU，超过最高上限或单号轮询低于3秒直接403/400拦截。',
        'callouts': [
            '1. 选定参考 SKU 自动带入行情最高上限 ceiling',
            '2. 出价/秒拍高于上限 → 403 拦截（除非王主管特批）',
            '3. 智能生成包含词/排除词，复用真实 sxjk 过滤链',
        ],
        'highlight_box': (200, 215, 535, 560),
        'arrow_from': (932, 330),
        'arrow_to': (540, 330),
        'narration': (
            '第二章来看闲鱼监控融合中心。新建全域关键词监听时，只要关联四维行情参考表的型号，'
            '系统会自动带上最高上限并接入真实过滤链。不管是普通监听价还是自动秒拍价，'
            '只要敢超过行情上限就会触发四零三硬拦截；单账号轮询低于三秒也会被风控保护拦下。'
        ),
    },
    {
        'id': 'ch3',
        'title': '第3章 · 5%红标号池拦截(409)、钉钉测试与422话术',
        'shot': SHOT_DIR / 'step_20_shot_1_step_shot5_accounts.png',
        'badge': '退款/纠纷红线 <=5% · 409 安全号隔离 · 422 违禁词',
        'subtitle': '闲鱼副号2达4.71%禁止承接高危秒拍，系统自动推举1.67%绿灯闲鱼3号并禁点小二介入。',
        'callouts': [
            '1. 30天退款率/纠纷率严守 ≤5%（3.8%黄灯预警）',
            '2. 副号2再退1单破5.88% → 409拦截改推闲鱼3号',
            '3. 未通过连接测试的钉钉机器人禁止绑定监控任务',
        ],
        'highlight_box': (422, 195, 646, 435),
        'arrow_from': (932, 305),
        'arrow_to': (650, 305),
        'narration': (
            '第三章看账号防红标与防封号护航。公司硬性规定三十天退款率和纠纷率不得超过百分之五。'
            '当闲鱼副号二达到百分之四点七一时，再退一单就会破线弹红标，系统会四零九强制拦下它接高风险秒拍，'
            '自动推荐绿灯闲鱼三号。同时聊天和话术全开四二二扫描，严禁泄密词、加微信和点小二介入。'
        ),
    },
    {
        'id': 'ch4',
        'title': '第4章 · 「几乎全新」买前禁追问与锁10图转采购单',
        'shot': SHOT_DIR / 'step_16_shot_1_step_shot3_monitor_hits.png',
        'badge': '买前严禁追问划痕 · 10图快照冻结 · 核改价',
        'subtitle': '监控标「几乎全新」绝不进闲鱼问划痕防卖家补充免责！直接锁10图快照打质疑标转单。',
        'callouts': [
            '1. 琥珀警报：标「几乎全新」买前严禁多嘴追问划痕',
            '2. 点「锁10图快照转采购单」同步创建不可篡改证据',
            '3. 买前第4步必须勾选「卖家已改价」才准登记付款',
        ],
        'highlight_box': (195, 225, 540, 445),
        'arrow_from': (932, 345),
        'arrow_to': (545, 345),
        'narration': (
            '第四章极其关键：当实时命中池标出卖家写着几乎全新或九九新时，买前严禁多嘴追问划痕，'
            '否则卖家一旦补充说明有划痕，咱们到货就失去拆项议价权！直接点锁定十图快照转入采购单，'
            '打上质疑成色标，谈好价核对卖家改价再付款。'
        ),
    },
    {
        'id': 'ch5',
        'title': '第5章 · 次日10点昨日对账单自动同步与防漏补抓',
        'shot': SHOT_DIR / 'step_14_shot_1_step_shot2_home.png',
        'badge': '次日 10:00 自动拉取 · 零手传表 · 409 签收锁',
        'subtitle': '财务对账单每天上午10点前自动推入首页，红框漏单一点「补抓生成采购单」，不消零不准签收。',
        'callouts': [
            '1. 财务接口 09:25 自动对齐昨日全天账单（无手传入口）',
            '2. 红框漏单 ST-06 / ST-07 点一键补抓直推仓管深检',
            '3. 存在未消漏单或差额时，会计签收按 409 拦截',
        ],
        'highlight_box': (195, 225, 868, 420),
        'arrow_from': (932, 300),
        'arrow_to': (872, 300),
        'narration': (
            '第五章解决漏抓单隐患。每天早上十点前，财务会把昨日企业支付宝和闲鱼扣款账单通过接口自动推入首页，'
            '系统已彻底去掉冗余人工传表。出现红色系统漏抓单时，点一键补抓立刻生成正式采购单并推仓管重点核验；'
            '异常未全部清零前，会计签收按钮会被四零九锁死。'
        ),
    },
    {
        'id': 'ch6',
        'title': '第6章 · 顺丰10m拒签、双轨9步二次议价与95338锁',
        'shot': SHOT_DIR / 'step_22_shot_1_step_shot6_case_detail.png',
        'badge': 'WIN-BG-03 派送盯梢 · P1-P6xG1-G6 十二奇兵 · 95338锁',
        'subtitle': '派送秒推仓管10m一镜到底视频；顺丰站点拒签或已签退货双轨切换，十二奇兵压价+95338截停护航。',
        'callouts': [
            '1. 仅仓管岗可交 10m 一镜到底验机视频定级（403隔离）',
            '2. 3色情绪分类 + 1/2半价或P3拆项首刀 + 十二奇兵',
            '3. 卖家若打 95338 退回，截回确认前 409 锁死入库',
        ],
        'highlight_box': (195, 365, 868, 595),
        'arrow_from': (932, 460),
        'arrow_to': (872, 460),
        'narration': (
            '第六章进入核心的到货二次议价驾驶舱。后台三号窗盯到顺丰派送立刻秒推赵仓管十分钟一镜到底开箱验机。'
            '遇到暗伤立刻走拒签加微或已签收退货留货双轨，按红黄绿信号与半价、拆项首刀搭配十二奇兵压价。'
            '万一卖家致电九五三三八强行退回，系统四零九锁死入库直到确认截回，杜绝货款两失。'
        ),
    },
    {
        'id': 'ch7',
        'title': '第7章 · 整单退关单 + T+1对公审批与两段独立10%',
        'shot': SHOT_DIR / 'step_24_shot_1_step_shot7_finance_comm.png',
        'badge': 'B-01 脱离平台管辖 · 钱货双清 · 两段 10% 永不重算',
        'subtitle': '首选闲鱼整单退关单+次日10点对公直转；两段10%各自独立入账，到货R绝不回代重算买前！',
        'callouts': [
            '1. B-01 整单退关单脱离闲鱼裁决与 5% 考核绑定',
            '2. 陈会计 T+1 对公核销 + 赵仓管入良品库形成钱货双清',
            '3. 买前 (M-P)x10% 与到货 Rx10% 永远独立计算不互相覆盖',
        ],
        'highlight_box': (195, 215, 868, 495),
        'arrow_from': (932, 340),
        'arrow_to': (872, 340),
        'narration': (
            '最后第七章是结算与提成。大额折让优先选闲鱼整单全额退关单，加次日十点支付宝对公直转，'
            '彻底摆脱平台纠纷考核。会计核清回执且仓管入良品库后，第二段到货百分之十提成转正确认。'
            '请记住：买前谈下的省额提成与到货二次议价省额提成两段完全独立核算，绝对不会回代重算。'
        ),
    },
]


def draw_handdrawn_rect(draw, box, color, width=4):
    x1, y1, x2, y2 = box
    # Double-stroke sketchy feel
    draw.rectangle([x1, y1, x2, y2], outline=color, width=width)
    draw.rectangle([x1 - 2, y1 + 2, x2 - 2, y2 + 2], outline=color, width=1)


def draw_arrow(draw, start, end, color=(220, 38, 38), width=5):
    sx, sy = start
    ex, ey = end
    draw.line([sx, sy, ex, ey], fill=color, width=width)
    # Arrowhead
    import math
    ang = math.atan2(ey - sy, ex - sx)
    head_len = 18
    a1 = ang + math.pi * 0.82
    a2 = ang - math.pi * 0.82
    p1 = (ex + head_len * math.cos(a1), ey + head_len * math.sin(a1))
    p2 = (ex + head_len * math.cos(a2), ey + head_len * math.sin(a2))
    draw.polygon([(ex, ey), p1, p2], fill=color)


def wrap_text(text, font, max_width, draw):
    lines = []
    cur = ''
    for ch in text:
        cand = cur + ch
        if draw.textlength(cand, font=font) > max_width and cur:
            lines.append(cur)
            cur = ch
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return lines


def render_slide(ch, idx, out_png):
    W, H = 1280, 720
    canvas = Image.new('RGB', (W, H), (250, 248, 244))
    draw = ImageDraw.Draw(canvas)

    # Subtle graph paper lines
    for gx in range(0, W, 40):
        draw.line([(gx, 0), (gx, H)], fill=(241, 238, 229), width=1)
    for gy in range(0, H, 40):
        draw.line([(0, gy), (W, gy)], fill=(241, 238, 229), width=1)

    f_title = load_font(FONT_BOLD, 28)
    f_badge = load_font(FONT_BOLD, 16)
    f_callout_hd = load_font(FONT_BOLD, 18)
    f_callout = load_font(FONT_LIGHT, 16)
    f_sub = load_font(FONT_BOLD, 19)

    # Top Header
    draw.rectangle([28, 18, W - 28, 76], fill=(15, 23, 42))
    draw.text((48, 30), ch['title'], fill=(255, 255, 255), font=f_title)
    badge_w = int(draw.textlength(ch['badge'], font=f_badge)) + 28
    draw.rounded_rectangle([W - 44 - badge_w, 29, W - 44, 65], radius=8, fill=(15, 118, 110))
    draw.text((W - 30 - badge_w, 37), ch['badge'], fill=(255, 255, 255), font=f_badge)

    # Left UI Screenshot Card (x: 32..910, y: 94..615)
    frame_box = (32, 94, 910, 616)
    draw.rounded_rectangle([36, 98, 914, 620], radius=12, fill=(203, 213, 225))
    draw.rounded_rectangle(frame_box, radius=10, fill=(255, 255, 255), outline=(100, 116, 139), width=2)

    if ch['shot'].exists():
        shot = Image.open(ch['shot']).convert('RGB')
        target_w = frame_box[2] - frame_box[0] - 12
        target_h = frame_box[3] - frame_box[1] - 12
        sw, sh = shot.size
        scale = min(target_w / sw, target_h / sh)
        nw, nh = int(sw * scale), int(sh * scale)
        shot_resized = shot.resize((nw, nh), Image.Resampling.LANCZOS)
        ox = frame_box[0] + (frame_box[2] - frame_box[0] - nw) // 2
        oy = frame_box[1] + (frame_box[3] - frame_box[1] - nh) // 2
        canvas.paste(shot_resized, (ox, oy))

    # Hand-drawn highlight rectangle + red arrow
    draw_handdrawn_rect(draw, ch['highlight_box'], color=(220, 38, 38), width=4)

    # Right Sticky Callout Card (x: 934..1250, y: 96..614)
    note_box = (934, 96, 1250, 614)
    draw.rounded_rectangle([939, 101, 1255, 619], radius=12, fill=(226, 232, 240))
    draw.rounded_rectangle(note_box, radius=12, fill=(255, 251, 235), outline=(217, 119, 6), width=3)
    draw.rounded_rectangle([934, 96, 1250, 146], radius=10, fill=(217, 119, 6))
    draw.text((954, 110), f'【实战防呆重点 {idx+1}/7】', fill=(255, 255, 255), font=f_callout_hd)

    cy = 166
    for ctext in ch['callouts']:
        wrapped = wrap_text(ctext, f_callout, 260, draw)
        draw.rounded_rectangle([948, cy - 6, 1236, cy + len(wrapped) * 24 + 10], radius=8, fill=(255, 255, 255), outline=(253, 230, 138), width=2)
        for line in wrapped:
            draw.text((960, cy + 2), line, fill=(30, 41, 59), font=f_callout)
            cy += 24
        cy += 22

    # Bottom Reminder stamp in sticky note
    draw.rounded_rectangle([950, 520, 1234, 598], radius=8, fill=(236, 253, 245), outline=(5, 150, 105), width=2)
    draw.text((962, 532), '◆ 所有规则均有后端硬拦截', fill=(6, 95, 70), font=f_badge)
    draw.text((962, 558), '400 / 403 / 409 / 422', fill=(15, 118, 110), font=f_callout_hd)

    draw_arrow(draw, ch['arrow_from'], ch['arrow_to'], color=(220, 38, 38), width=5)

    # Bottom Subtitle Ribbon
    draw.rounded_rectangle([32, 634, W - 32, 702], radius=10, fill=(15, 23, 42))
    sub_lines = wrap_text(ch['subtitle'], f_sub, W - 110, draw)
    sy = 644 if len(sub_lines) > 1 else 656
    for sline in sub_lines[:2]:
        draw.text((54, sy), sline, fill=(248, 250, 252), font=f_sub)
        sy += 26

    canvas.save(out_png)


def synth_voice(text, out_wav, work_dir):
    txt_file = Path(work_dir) / f'{out_wav.stem}.txt'
    txt_file.write_text(text, encoding='utf-8')
    cmd1 = [TTS_SH, '--voice', 'serious', '--text-file', str(txt_file), '--output', str(out_wav)]
    res = subprocess.run(cmd1, capture_output=True, text=True, timeout=180)
    if res.returncode != 0 or not out_wav.exists():
        print(f'[TTS] daemon retry with --direct for {out_wav.stem}: {res.stderr[-200:]}')
        cmd2 = [TTS_SH, '--voice', 'serious', '--direct', '--text-file', str(txt_file), '--output', str(out_wav)]
        res2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=240)
        if res2.returncode != 0 or not out_wav.exists():
            raise RuntimeError(f'TTS failed even with --direct: {res2.stderr}')


def probe_duration(path_media):
    res = subprocess.run(
        [FFPROBE, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(path_media)],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(res.stdout.strip())


def main():
    with tempfile.TemporaryDirectory(prefix='panasia_v6_vid_') as tmp:
        tmp_path = Path(tmp)
        seg_files = []
        meta_chapters = []
        cursor = 0.0

        for i, ch in enumerate(CHAPTERS):
            png = tmp_path / f'{ch["id"]}.png'
            wav = tmp_path / f'{ch["id"]}.wav'
            seg = tmp_path / f'{ch["id"]}.mp4'
            print(f'==> [{i+1}/7] Rendering slide & synthesizing voice for {ch["id"]}...')
            render_slide(ch, i, png)
            synth_voice(ch['narration'], wav, tmp_path)
            dur = probe_duration(wav) + 0.45

            # Render still frame + audio into uniform h264/aac segment
            subprocess.run(
                [
                    FFMPEG, '-y',
                    '-loop', '1', '-i', str(png),
                    '-i', str(wav),
                    '-t', f'{dur:.3f}',
                    '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
                    '-r', '24', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
                    '-af', 'apad=pad_dur=0.5',
                    str(seg),
                ],
                check=True,
                capture_output=True,
            )
            seg_dur = probe_duration(seg)
            meta_chapters.append({
                'id': ch['id'],
                'title': ch['title'],
                'startSec': round(cursor, 2),
                'durationSec': round(seg_dur, 2),
                'summary': ch['subtitle'],
            })
            cursor += seg_dur
            seg_files.append(seg)

        concat_txt = tmp_path / 'concat.txt'
        concat_txt.write_text('\n'.join(f"file '{s}'" for s in seg_files), encoding='utf-8')
        print(f'==> Concatenating {len(seg_files)} segments into {OUT_MP4}...')
        subprocess.run(
            [
                FFMPEG, '-y',
                '-f', 'concat', '-safe', '0', '-i', str(concat_txt),
                '-c', 'copy', '-movflags', '+faststart',
                str(OUT_MP4),
            ],
            check=True,
            capture_output=True,
        )

        OUT_META.write_text(json.dumps(meta_chapters, ensure_ascii=False, indent=2), encoding='utf-8')
        print('DONE! Chapters timing:')
        print(json.dumps(meta_chapters, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
