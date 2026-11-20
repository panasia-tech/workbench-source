"""群控 ADB 守护 - 图形界面(tkinter)。双击即用:选配置 → 启动 → 看日志。"""
from __future__ import annotations

import logging
import os
import queue
import shutil
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext

import yaml

from gc_adb.daemon import Daemon

log = logging.getLogger("gc_adb.gui")


def _base_dir() -> str:
    """打包后取 exe 所在目录;开发时取项目根目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _default_config() -> str:
    """exe 旁边的 config.yaml;没有就从打包内置的 example 复制一份。"""
    path = os.path.join(_base_dir(), "config.yaml")
    if not os.path.exists(path):
        example = os.path.join(getattr(sys, "_MEIPASS", _base_dir()), "config.example.yaml")
        if os.path.exists(example):
            shutil.copy(example, path)
    return path


class _QueueHandler(logging.Handler):
    """把日志记录丢进队列,由 Tk 主线程定时取走显示(线程安全)。"""

    def __init__(self, q: queue.Queue) -> None:
        super().__init__()
        self.q = q

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.q.put(self.format(record))
        except Exception:
            pass


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("群控 ADB 守护")
        self.geometry("760x520")
        self.minsize(600, 400)

        self.daemon: Daemon | None = None
        self.thread: threading.Thread | None = None
        self._handler: _QueueHandler | None = None
        self.log_q: queue.Queue[str] = queue.Queue()

        self._build_widgets()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(200, self._drain_logs)
        log.info("就绪。确认 adb 可用、手机已开 USB 调试后点「启动」。")

    def _build_widgets(self) -> None:
        top = tk.Frame(self, padx=8, pady=8)
        top.pack(fill=tk.X)

        tk.Label(top, text="配置文件:").pack(side=tk.LEFT)
        self.cfg_var = tk.StringVar(value=_default_config())
        tk.Entry(top, textvariable=self.cfg_var).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4)
        tk.Button(top, text="浏览…", command=self._browse).pack(side=tk.LEFT)
        tk.Button(top, text="打开配置", command=self._open_config).pack(side=tk.LEFT, padx=(4, 0))

        bar = tk.Frame(self, padx=8)
        bar.pack(fill=tk.X)
        self.toggle_btn = tk.Button(bar, text="启 动", width=10, command=self._toggle)
        self.toggle_btn.pack(side=tk.LEFT)
        tk.Button(bar, text="清空日志", command=self._clear_log).pack(side=tk.LEFT, padx=8)
        self.status_var = tk.StringVar(value="未运行")
        tk.Label(bar, textvariable=self.status_var, fg="#666").pack(side=tk.LEFT, padx=8)

        self.log_text = scrolledtext.ScrolledText(self, padx=8, pady=8, font=("Consolas", 9))
        self.log_text.pack(fill=tk.BOTH, expand=True)

    def _browse(self) -> None:
        path = filedialog.askopenfilename(
            title="选择配置文件", filetypes=[("YAML", "*.yaml *.yml"), ("所有文件", "*.*")]
        )
        if path:
            self.cfg_var.set(path)

    def _open_config(self) -> None:
        path = self.cfg_var.get()
        if not os.path.exists(path):
            messagebox.showwarning("提示", f"文件不存在:\n{path}")
            return
        if sys.platform.startswith("win"):
            os.startfile(path)  # type: ignore[attr-defined]
        else:
            import subprocess

            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path])

    def _clear_log(self) -> None:
        self.log_text.delete("1.0", tk.END)

    def _toggle(self) -> None:
        if self.daemon is None:
            self._start()
        else:
            self._stop()

    def _start(self) -> None:
        try:
            with open(self.cfg_var.get(), encoding="utf-8") as f:
                cfg = yaml.safe_load(f)
            daemon = Daemon(cfg)
        except Exception as e:
            messagebox.showerror("启动失败", f"{e}")
            return

        self._handler = _QueueHandler(self.log_q)
        self._handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S"))
        root = logging.getLogger()
        root.setLevel(logging.INFO)
        root.addHandler(self._handler)

        self.daemon = daemon
        self.thread = threading.Thread(target=self._run_daemon, daemon=True)
        self.thread.start()
        self.toggle_btn.config(text="停 止")
        self.status_var.set("运行中")

    def _run_daemon(self) -> None:
        try:
            self.daemon.run()  # type: ignore[union-attr]
        except Exception as e:
            self.log_q.put(f"守护异常退出: {e}")
        finally:
            self.log_q.put("__stopped__")

    def _stop(self) -> None:
        if self.daemon is not None:
            self.status_var.set("正在停止…")
            self.daemon.stop()

    def _on_stopped(self) -> None:
        if self._handler is not None:
            logging.getLogger().removeHandler(self._handler)
            self._handler = None
        self.daemon = None
        self.thread = None
        self.toggle_btn.config(text="启 动")
        self.status_var.set("未运行")

    def _drain_logs(self) -> None:
        try:
            while True:
                line = self.log_q.get_nowait()
                if line == "__stopped__":
                    self._on_stopped()
                else:
                    self.log_text.insert(tk.END, line + "\n")
                    self.log_text.see(tk.END)
        except queue.Empty:
            pass
        self.after(200, self._drain_logs)

    def _on_close(self) -> None:
        self._stop()
        self.after(500, self.destroy)


def main() -> None:
    App().mainloop()
