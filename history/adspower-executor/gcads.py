"""PyInstaller 打包入口：单 exe 同时承载 executor 与运维 CLI。

  gc-ads executor --user-id <env>   # 跑执行端（等价 main.py）
  gc-ads doctor / list / start ...  # 运维命令（等价 manage.py）

开发态请继续直接用 main.py / manage.py；本入口只为打包存在。
启动即 chdir 到 app_root()：config.yaml、device_identity_*.json、logs/、
run/、tmp/ 全部落在 exe 旁边，与 cwd 无关（操作员双击/计划任务启动都安全）。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from gc_ads.paths import app_root, is_frozen

# Windows 控制台默认 GBK,输出里的 ✓/✗ 等字符会 UnicodeEncodeError 直接崩进程
# (2026-09-10 txy 打包版实测)。errors=replace 降级为「?」兜底,宁可丑不可崩。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

os.chdir(app_root())

# 热更新：exe 旁边有一份通过校验的新代码就用它，否则用包里内置的那份。
# **这个文件本身永远不参与热更新**——它要是坏了，只能重新打包才救得回来，
# 所以这里只做「挑哪份代码」这一件事，别往里加业务逻辑（同桌面端 loader.js）。
try:
    from gc_ads import hot_code

    # 只在打包态启用。开发态（python main.py / manage.py）跑的必须是你正在改的源码——
    # 否则下载下来的那份会**悄悄盖住工作区**，改了没反应还查不出为什么
    # （2026-09-14 实测：启动第一拍就下了一份，之后跑的都是那个快照）。
    _hot = hot_code.activate(app_root()) if is_frozen() else {"active": False, "reason": "开发态"}
except Exception as _exc:      # 加载器自身出问题也绝不能挡住启动
    print(f"热更新加载器异常，用内置版本: {_exc}", file=sys.stderr)
    _hot = {"active": False}

# 首启兜底：exe 旁边没有 config.yaml 时，从打包内置的 example 复制一份，
# 并在日志里明确提示要编辑——避免操作员面对「静默退出」无所适从。
_cfg = app_root() / "config.yaml"
if is_frozen() and not _cfg.exists():
    _example = Path(getattr(sys, "_MEIPASS", "")) / "config.example.yaml"
    if _example.exists():
        _cfg.write_text(_example.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"已生成 {_cfg}，请编辑填入 server/enroll_secret/environments 后再启动",
              file=sys.stderr)


def main() -> None:
    argv = sys.argv[1:]
    # 走到这里说明选中的那份代码至少 import 成功了。真正「跑起来了」的标记由
    # 下面各自的入口点掉——见 hot_code.mark_boot_ok 的说明（不删就会被当成坏版本）。
    if argv and argv[0] == "executor":
        sys.argv = [sys.argv[0]] + argv[1:]
        from main import main as executor_main
        asyncio.run(executor_main())
    else:
        from manage import main as manage_main
        # 运维命令（doctor/list/run/broker…）import 得起来也算起来了，同样撤掉 boot-pending。
        # 原来只有执行端撤：守护端跑一次 list，标记就留下了，下次执行端启动把好好的热更新
        # 当成「上一版起不来」隔离掉（2026-10-06 重打包前发现）。
        _mark_boot_ok()
        manage_main()


def _mark_boot_ok() -> None:
    try:
        from gc_ads import hot_code as _hot_code
        _hot_code.mark_boot_ok(app_root())
    except Exception:
        pass


if __name__ == "__main__":
    main()
