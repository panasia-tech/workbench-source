# ERP RFID 手持机 App

iData PDA 上的 RFID **绑定 + 盘点** App，对接 ERP 后端（FastAPI，默认 `http://127.0.0.1:8000`）。

## 已打包的 APK

`PDA/ERP-RFID-debug.apk`（debug 签名，可直接安装）。

## 安装到 PDA

```bash
# USB 连接 PDA（开发者模式 + USB 调试），然后：
adb install -r PDA/ERP-RFID-debug.apk
# 或：把 apk 拷进设备用文件管理器点击安装
```

## 使用前置条件（后端）

1. 服务器执行迁移并建设备账号：
   ```bash
   cd server && alembic upgrade head
   python scripts/create_rfid_device.py        # 默认账号 rfid01 / 密码 rfid888888
   # 重启 uvicorn
   ```
2. App 首次打开：填服务器地址 + 账号密码登录，token 存本地、7 天有效、启动自动续期。

## 功能

- **绑定**：扫货品条码(得 sku_code) → 按【扳机】低功率读最近一张标签 → 自动绑定。
  防串读：8dBm 低功率 + 取最强信号 + 多张时拒绝。
- **盘点**：点「开始盘点」建会话 → 高功率(27dBm)连续盘读、实时去重计数 →
  点「结束盘点」上传并生成盘点记录（含在库/缺失/多出差异）。小程序与管理后台都能查看。

## 设备相关约定（如机型不同需调整）

- **机型**：iData PDA（emsh 框架，串口 `/dev/ttyMT2`，`RfidPower.PDATYPE.IDATA`）。
  设备层与 UHF SDK(`com.uhf.api`/`com.pow.api`)、`.so` 均取自原 EI.apk。
- **扳机键码**：`138`（见 `BindActivity`/`StocktakeActivity` 的 `KEY_TRIGGER`）。若你的机型不同，改这个常量。
- **条码扫描**：用「键盘楔入」方式（扫码枪把条码当键盘输入打进焦点框，回车结束）。
  **请在 PDA 系统的扫描设置里把输出模式设为「键盘/Keyboard」**，否则绑定页收不到条码。
- **ABI**：仅打包 `armeabi`/`armeabi-v7a`（32 位 ARM）。iData UHF 模块为 32 位；若是纯 arm64 机型需另寻 64 位 `.so`。

## 从源码重新构建

环境：JDK 17 + Android SDK（platform-34, build-tools 34）。本仓库 `settings.gradle` 已配阿里云镜像。

```bash
cd PDA/android
echo "sdk.dir=$HOME/android-sdk" > local.properties     # 指向你的 Android SDK
gradle :app:assembleDebug                                 # 产物在 app/build/outputs/apk/debug/
# 正式发布签名版：配置 keystore 后 gradle :app:assembleRelease
```

## 工程结构

```
app/src/main/
  java/com/erp/rfid/
    net/      Prefs(本地存储) · Api(OkHttp 接口封装)
    device/   UhfReader(UHF 读头+emsh+功率封装)
    ui/       LoginActivity · HomeActivity · BindActivity · StocktakeActivity
  res/layout/ 四个页面布局
  jniLibs/    armeabi(-v7a)/libModuleAPIJni.so, libserial_port_idata.so
app/libs/uhf-sdk.jar   ← 从 EI.apk 提取的 iData UHF SDK（二进制）
```
