"""部署形态路径解析。

开发态（python main.py / manage.py）：项目根目录 = gc_ads 包的上一级。
打包态（PyInstaller onefile）：程序根目录 = exe 所在目录，config.yaml、
device_identity_*.json、logs/、run/、tmp/ 都放在 exe 旁边——操作员只需
把整个文件夹拷走，不依赖安装路径。
内嵌进卖家工作台时：程序在安装目录（升级会整个换掉），数据目录由桌面端用
GC_ADS_HOME 指定，上面这些文件都放那里。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def app_root() -> Path:
    home = os.environ.get("GC_ADS_HOME")
    if home:
        return Path(home).resolve()
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent
