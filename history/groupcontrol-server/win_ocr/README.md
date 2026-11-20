# 家用 Windows GPU OCR —— 群控服务端 OCR 的唯一算力端

自 2026-08-17 起,`groupcontrol-server` 的服务端 OCR **只有这一条路**。已下掉的:

| 下掉的 | 为什么 |
|---|---|
| 石榴(shiliuai)云 OCR | 付费,不再用 |
| zndjs 云 OCR | 付费,不再用 |
| 服务器本机 RapidOCR | Linux 生产机没 GPU;且 onnxruntime 在其上原生内存只涨不返(~20MB/次,1~2 小时把 gc-api 撑到 OOM,连带杀掉正在跑的任务) |

**没有兜底是刻意的**:这台机器或隧道一挂,`ocr()` 直接抛错、流程判失败。别再往
`app/flow/ocr.py` 里悄悄加回落引擎——静默换引擎会改变检测框切分与分词,而 `find()` 的锚点
匹配是按 PP-OCRv3 的行为一次次踩坑调出来的。

## 架构

```
gc-api(腾讯云 122.51.208.149,OpenCloudOS)
  └─ ocr(png) ─ POST http://127.0.0.1:8600/ocr ─┐
                                                 │  sshd:22 ←── ssh -N -R ──┐
                          服务器 127.0.0.1:8600 ─┘                          │ 家宽出网连接
                                                                            ▼
                          家用 Windows: ocr_server.py(RapidOCR + CUDA)127.0.0.1:8600
                          i5-14600K / 16GB / RTX 5070
```

- 家宽**没有公网 IP、不能做端口映射**,所以由 Windows 主动 `ssh -R` 出网打洞。
- 隧道口只在服务器 `127.0.0.1:8600`(sshd 默认 `GatewayPorts no`),**不暴露公网**。
- 服务器侧**不新开任何公网端口、不装任何新服务**——只用已经开着的 22。
- 再加一层弱鉴权:请求头 `X-OCR-Token` 要与 Windows 侧 `GC_OCR_HTTP_TOKEN` 一致。

### 为什么不用旧的 frp(mac_ocr 那套)
frps 要在服务器新装 + 开一个公网端口 + **改腾讯云安全组**。SSH 走已经开着的 22,零新增
服务;而且能用 `authorized_keys` 的 `restrict,permitlisten` 把这把钥匙锁死成「只能开
127.0.0.1:8600 这一条隧道」——家用电脑不该拿到服务器的 shell。

## 部署

### Windows 侧(3 步)

前置:Python 3.12(装时勾 Add to PATH)、NVIDIA 驱动够新(能跑 CUDA 12.8;RTX 5070 是
Blackwell/sm_120,老驱动不认)、Win10 1809+ 自带的 OpenSSH 客户端。

```powershell
cd <仓库>\groupcontrol-server\win_ocr

# 1. 一次性安装(venv + OCR/CUDA 依赖 + 生成 SSH 密钥 + GPU 真实自检)
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
#    结束时会打印一行 authorized_keys 内容,拿去做下面「服务器侧」第 1 步

# 2. 手动验证(前台跑,看得见日志;Ctrl-C 退)
#    注意必须带 -ExecutionPolicy Bypass:默认执行策略会拦掉 .\run.ps1 这种裸调用
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Token <与服务器 .env 同值>

# 3. 设开机自启(管理员 PowerShell)
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-task.ps1
Start-ScheduledTask gc-ocr; Start-ScheduledTask gc-ocr-tunnel
```

`setup.ps1` 的 GPU 自检会真的跑一次推理并要求 **det/rec/cls 三个模型全部在 CUDA 上**。
过不了它会打印排查顺序——**别跳过**,因为 ORT 拿不到 CUDA 时只 warn 一句就静默用 CPU 跑。

### 服务器侧(2 步)

```bash
# 1. 建专用受限用户 + 贴公钥(把 setup.ps1 打印的那一整行贴进去)
useradd -m gcocr
mkdir -p ~gcocr/.ssh && chmod 700 ~gcocr/.ssh
vi ~gcocr/.ssh/authorized_keys      # 内容形如:
#   restrict,port-forwarding,permitlisten="127.0.0.1:8600" ssh-ed25519 AAAA... gc-ocr-win
chmod 600 ~gcocr/.ssh/authorized_keys && chown -R gcocr: ~gcocr/.ssh

# 2. gc-api 的 .env(/www/wwwroot/groupcontrol-server/.env)
#    删掉/注释 GC_OCR_SHILIUAI_* 和 GC_OCR_ZNDJS_*(留着也无害,新代码已不读),然后:
GC_OCR_HTTP_URL=http://127.0.0.1:8600/ocr
GC_OCR_HTTP_TOKEN=<与 Windows 侧同值>
GC_OCR_HTTP_TIMEOUT=30
#    systemctl restart gc-api
```

建议顺手给 sshd 加上(家里突然断网时,服务器能及时回收 8600 上的僵尸监听,
否则下次重连会被 `ExitOnForwardFailure` 挡住直到 TCP 超时):

```
# /etc/ssh/sshd_config
ClientAliveInterval 30
ClientAliveCountMax 3
# systemctl reload sshd   (不影响已有连接)
```

### 上线顺序(别搞反)

新代码已经**没有云 OCR 兜底**,所以必须先有隧道再上代码:

1. Windows 侧跑通 → 服务器上 `curl -s http://127.0.0.1:8600/healthy` 能返回 `"gpu":true`;
2. 再部署 gc-api 新代码 + 改 `.env` + 重启;
3. 用探针验真机:`cd /www/wwwroot/groupcontrol-server && venv/bin/python scripts/ocr_probe.py`。

反过来先上代码,那段时间 OCR 全废(所有含锚点定位的流程都会失败)。

## 自检

```bash
# 服务器上:隧道 + 服务 + GPU 一起验
ssh -i deploy/ssh/erp-txy root@127.0.0.1 'curl -s http://127.0.0.1:8600/healthy'
# 期望: {"ok":true,"engine":"rapidocr_onnxruntime==1.2.3 (PP-OCRv3)","gpu":true,"providers":{...},...}
#        gpu 必须是 true;false = 在用 CPU 慢慢跑,查 Windows 侧 gc-ocr.log
```

```powershell
# Windows 上
Get-Content .\gc-ocr.log -Tail 30 -Wait        # OCR 服务日志(含预热耗时/providers)
Get-Content .\gc-tunnel.log -Tail 30 -Wait     # 隧道日志
Invoke-RestMethod http://127.0.0.1:8600/healthy
```

`/healthy` 里的 `last_ms` 是最近一次识别耗时,可以直接看 GPU 到底有没有在干活。

## 四处要对齐的值(改一处就得改另一处)

| 项 | 值 | 位置 |
|---|---|---|
| OCR 弱鉴权 token | `gc-ocr-shared-2026`(建议改掉) | Windows `run.ps1 -Token` / `install-task.ps1` ↔ 服务器 `.env` 的 `GC_OCR_HTTP_TOKEN` |
| 端口 | `8600` | `ocr_server`(uvicorn)↔ `ssh -R` 两端 ↔ 服务器 `GC_OCR_HTTP_URL` |
| SSH 公钥 | ed25519 | Windows `win_ocr\ssh\gcocr(.pub)` ↔ 服务器 `~gcocr/.ssh/authorized_keys` |
| 服务器地址/用户 | `gcocr@127.0.0.1` | `run.ps1 -ServerHost/-SshUser` ↔ 服务器上的用户名 |

## 关于模型(为什么钉死 PP-OCRv3)

现在跑的是 `rapidocr-onnxruntime==1.2.3` 自带的 **PP-OCRv3 mobile**(det 3MB / rec 11MB /
cls 方向分类)。**别顺手升级**:

这个场景的难点不是「字认不认得对」,而是**检测框怎么切、切出来的文字怎么分行分段**——
`find()` 的三个历史坑(「定价」被长句「…帮你智能定价」抢、「确定」被问句「确定要下架
这个宝贝吗?」抢、卡片标题被营销横幅抢)全都是分框/分词行为的问题,不是识别精度问题。
换 PP-OCRv4/v5 或换 rapidocr 2.x/3.x(默认模型就是 v4/v5),分框行为一变,这些锚点要全部重验。

GPU 改造**只换执行后端(CPU EP → CUDA EP),模型文件和输出结构完全不变**,所以对上游无感。

真要升精度(GPU 有富余算力,PP-OCRv5 官方口径比 v4 端到端提升明显,对小字/密排更稳),
正确姿势是**单独一次改动**:先拿一批真实截图跑 v3 vs 新版对比,确认 `find()` 对
「定价 / 确定 / 立即发布 / 卖闲置 / 我的 / 一键登录」这些锚点的命中位置一致,再切。
顺序上先把这条隧道链路跑稳,别把两个变量混在一起。

一个便宜的提速开关:`GC_OCR_USE_ANGLE_CLS=0`。手机截图永远不会上下颠倒,方向分类器纯属
白跑,关掉能省一个模型和一段耗时。默认 `1` 是为了和旧 CPU 版行为完全一致。

## 环境变量(Windows 侧)

| 变量 | 默认 | 说明 |
|---|---|---|
| `GC_OCR_HTTP_TOKEN` | (空) | 弱鉴权;空=不校验。与服务器 `.env` 同值 |
| `GC_OCR_USE_GPU` | `1` | `0` = 纯 CPU 跑(i5-14600K 也够用,约 150~400ms/张) |
| `GC_OCR_REQUIRE_GPU` | `1` | 要 GPU 但没拿到就**启动失败**(而不是静默 CPU) |
| `GC_OCR_GPU_ID` | `0` | CUDA 设备号。CUDA EP 只看得见 NVIDIA 卡,0 就是 5070(核显不算) |
| `GC_OCR_USE_ANGLE_CLS` | `1` | 见上,置 0 省一个模型 |
| `GC_OCR_WARMUP_SIZE` | `1080x2400` | 预热合成图尺寸,写真实截图分辨率(CUDA 按输入 shape 缓存卷积算法) |
| `OCR_RECYCLE_CALLS` | `0` | 每 N 次调用自杀由 run.ps1 拉起。GPU 版默认关(CUDA 冷启动 5~10s,而这条路没兜底) |

## 排障

- **`module 'onnxruntime' has no attribute '__version__'`(或 `get_available_providers` 不存在)**:
  onnxruntime 被删穿了。CPU 版 `onnxruntime` 和 `onnxruntime-gpu` **装进同一个
  `site-packages\onnxruntime\` 目录**,两个都装过再卸掉一个,pip 会把共用文件一起删掉,
  剩下的空目录被 Python 当成命名空间包 —— import 能过但没有任何属性。**pip 修不了这种状态**,
  必须连目录一起删。`setup.ps1` 开头会自动检测并清理;手动修:
  `pip uninstall -y onnxruntime onnxruntime-gpu`,再删掉 `.venv\Lib\site-packages\onnxruntime`
  这个残留目录,然后 `pip install onnxruntime-gpu`。
  → 所以 **rapidocr 必须用 `--no-deps` 装**(它的依赖里写着 CPU 版 onnxruntime),
  它的其余依赖手工列在 `requirements.txt` 里。
- **`Error loading "onnxruntime_providers_cuda.dll" which depends on "cublasLt64_13.dll"
  which is missing`(Error 126)+ `Require cuDNN 9.* and CUDA 13.*`**:
  **ORT 轮子的 CUDA 大版本和 nvidia-* 轮子对不上**。ORT 的 Windows 轮子是按某个具体 CUDA
  大版本编的(1.28.0 要 CUDA **13**),配 `-cu12` 轮子就会缺 `cublasLt64_13.dll` →
  CUDA EP 加载失败 → **静默回落 CPU**。修法:把 nvidia 轮子换成同大版本
  (`nvidia-{cuda-runtime,cublas,cufft,curand,cudnn,nvjitlink,cuda-nvrtc}-cu13`)。
  2026-08-17 就是栽在这。**升 `onnxruntime-gpu` 前必须先确认新版本要哪个 CUDA 大版本**,
  所以 `requirements.txt` 里 ORT 是钉死版本号的。
- **`/healthy` 里 `gpu:false`**:CUDA EP 没注册上。① 先看上一条(CUDA 大版本对不上是最常见的);
  ② `pip list | findstr onnxruntime` 必须**只有** `onnxruntime-gpu`;③ `nvidia-smi` 看驱动
  (`CUDA UMD Version` 要 ≥ ORT 要求的大版本);④ 报
  `no kernel image is available for execution on the device` = ORT 太老不认 sm_120(Blackwell);
  ⑤ 自检脚本里**必须先 import ocr_server 再 import onnxruntime** —— DLL 目录要在 ORT 加载前
  登记好,反了会误报"没 GPU"而实际服务是好的。
  → 跑 `setup.ps1` 时自检不过会自动打印五段诊断并存到 `gpu-diag.txt`,直接看它。
- **服务器 `curl 127.0.0.1:8600/healthy` 不通**:看 Windows `gc-tunnel.log`。
  常见是服务器上 8600 还被上一个僵尸会话占着(`ss -lnt | grep 8600` 有,但打不开)——
  服务器上 `pkill -u gcocr sshd` 或等 `ClientAlive` 回收;这也是为什么建议配 `ClientAliveInterval`。
- **OCR 报 401**:两侧 `GC_OCR_HTTP_TOKEN` 不一致。
- **ssh 报 `Permissions for 'ssh\gcocr' are too open`**:重跑 `setup.ps1`(里面用 SID 而不是
  账户名调 `icacls`——中文版 Windows 上 `SYSTEM`/`Administrators` 的本地化名字会让 icacls 失败)。
- **计划任务显示在跑但没有效果**:任务以 SYSTEM 身份跑,读不到用户 profile 的 `~/.ssh`;
  所以私钥和 known_hosts 必须在 `win_ocr\ssh\`(`setup.ps1` 就是这么放的)。
- **半夜突然全断**:Windows 更新自动重启。设置 → Windows 更新 → 活动时间设全天。
  重启后两个计划任务会自己起来,但重启那几分钟 OCR 是断的(流程会失败,不会静默出错)。

## 性能与带宽

- 图片方向是**云端上行 → 家宽下行**,家宽下行富余;返回只是 JSON。体积和以前发给石榴的
  base64 一样(其实还省了 base64 的 33% 膨胀),不是新瓶颈。
- 识别串行化(单卡 + 一把锁),`/healthy` 走另一个线程所以始终秒回。真需要更高吞吐再说,
  当前群控的节奏(每账号 30s 最小操作间隔)远够不到上限。

## 相关

- 上游调用方:`app/flow/ocr.py`(`_ocr_remote` + `find`)、配置 `app/config.py` 的 `gc_ocr_http_*`
- 旧方案(Mac + frp,已停用)11-11 已从仓库删掉,要看翻 git 历史里的 `groupcontrol-server/mac_ocr/`
