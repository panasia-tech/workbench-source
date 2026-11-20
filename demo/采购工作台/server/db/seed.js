/**
 * 全量正式版初始业务与闲鱼监控数据集（仅首次空库幂等注入）
 */
import { hashPassword } from '../middleware/auth.js';

export function seedInitialData(db) {
  const existingStaff = db.prepare(`SELECT COUNT(*) AS cnt FROM staff_users`).get();
  if (Number(existingStaff?.cnt || 0) > 0) return;

  const ts = new Date().toISOString();
  const demoPassword = process.env.DEMO_PASSWORD;
  if (!demoPassword) throw new Error('首次启动请通过 DEMO_PASSWORD 设置本地演示密码');
  const demoPwdHash = hashPassword(demoPassword);

  // 1. 演示岗位账号（scrypt 哈希鉴权）
  const insStaff = db.prepare(
    `INSERT INTO staff_users (id, username, name, role, password_hash, practice_passed_gates, status, daily_comm_target_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 100000, ?)`
  );
  insStaff.run('liming', 'liming', '李明', 'PURCHASER', demoPwdHash, '["gate1","gate2","gate3"]', ts);
  insStaff.run('newbie', 'newbie', '陈小新', 'PURCHASER', demoPwdHash, '[]', ts);
  insStaff.run('zhaocg', 'zhaocg', '赵仓管', 'WAREHOUSE', demoPwdHash, '["gate1","gate2","gate3"]', ts);
  insStaff.run('chenkj', 'chenkj', '陈会计', 'FINANCE', demoPwdHash, '["gate1","gate2","gate3"]', ts);
  insStaff.run('wangzg', 'wangzg', '王主管', 'ADMIN', demoPwdHash, '["gate1","gate2","gate3"]', ts);

  // 2. 买货预算总池
  db.prepare(
    `INSERT INTO quota_pools (pool_id, title, total_budget_cents, reserved_cents, consumed_cents, updated_at)
     VALUES ('POOL-202611', '采购组本月买货预算池（2026年11月）', 5000000, 462000, 1260000, ?)`
  ).run(ts);

  // 3. 四维行情参考表（含五大核心机型）
  const insPb = db.prepare(
    `INSERT INTO pricebook_items (id, sku_code, model_name, category, condition_grade, version_no, ref_cents, initial_offer_cents, target_cents, ceiling_cents, status, created_by, approved_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insPb.run('PB-001', 'IP15P-256-NAT', 'iPhone 15 Pro 256G 国行原色', '苹果手机', '95新·电池90%以上无拆修', 2, 505000, 445000, 460000, 475000, 'published', 'wangzg', 'wangzg', ts);
  insPb.run('PB-002', 'SONY-A7M4-BODY', 'Sony A7M4 单机身 快门<2万', '相机微单', '95新·CMOS干净原盒', 2, 1060000, 960000, 990000, 1020000, 'published', 'wangzg', 'wangzg', ts);
  insPb.run('PB-004', 'MBP14-M3-16-512', 'MacBook Pro 14 M3 16+512', '笔记本电脑', '98新·电池92%以上', 2, 760000, 680000, 710000, 735000, 'published', 'wangzg', 'wangzg', ts);
  insPb.run('PB-005', 'ROG-XG27ACS-2K', 'ROG 27寸 2K 180Hz 电竞显示器', '电竞显示器', '99新·原盒完美屏', 1, 165000, 115000, 128000, 138000, 'published', 'wangzg', 'wangzg', ts);
  insPb.run('PB-006', 'IPADP11-M2-256', 'iPad Pro 11 M2 256G 深空灰', '平板电脑', '98新·屏幕无亮斑', 1, 390000, 345000, 360000, 375000, 'published', 'wangzg', 'wangzg', ts);
  insPb.run('PB-007', 'ASUS-VG27AQML1A', '华硕 TUF 27寸 2K 240Hz 显示器', '电竞显示器', '99新·原盒完美屏', 1, 135000, 95000, 105000, 112000, 'published', 'wangzg', 'wangzg', ts);

  // 4. 3个闲鱼采购账号 + 近30天5%防红标统计 + 1+3专窗拓扑
  const insAcct = db.prepare(
    `INSERT INTO xianyu_accounts (id, client_id, account_name, nickname, avatar, window_role, window_desc, login_status, im_realtime_ok, enabled, rolling_30d_orders, rolling_30d_refunds, rolling_30d_disputes, redline_pct, warn_pct, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'logged_in', 1, 1, ?, ?, ?, 5.0, 3.8, ?)`
  );
  insAcct.run('ACC-GF-01', 'ACC-GF-01', '闲鱼主号1', '泛亚直收一号铺', '/evidence/item_ip15p.jpg', 'WIN-FG-01', '前台人工监督主窗 #1（看真实聊天 · 暂停接管 · 核改价下单）', 120, 4, 1, ts);
  insAcct.run('ACC-GF-02', 'ACC-GF-02', '闲鱼副号2', '泛亚数码优选二号', '/evidence/item_mbp_m3.jpg', 'WIN-BG-01 / WIN-BG-02', '⚠️ 近30天85单退4单(4.71%)，再退1单破5.88%红标！严禁接高风险质疑单', 85, 4, 1, ts);
  insAcct.run('ACC-GF-03', 'ACC-GF-03', '闲鱼3号', '杭州个人淘机三号', '/evidence/item_a7m4.jpg', 'WIN-BG-03', '安全绿灯号(1.67%/0%纠纷)，顺丰派送盯梢专窗 · 推荐承接质疑成色链接', 60, 1, 0, ts);

  // 5. 1+3 专窗调度队列
  const insJob = db.prepare(
    `INSERT INTO executor_jobs (job_id, window_id, window_name, account_name, job_type, target_ref, status, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insJob.run('JOB-FG-01', 'WIN-FG-01', '前台人工监督主窗 #1', '闲鱼主号1', 'human_supervise', 'CONV-001 / CONV-002', 'active', '实时监督 6 个活跃议价会话，开启单人独占锁', ts);
  insJob.run('JOB-BG-01', 'WIN-BG-01', '后台执行窗 #1（抓快照 & 自动首报）', '闲鱼主号1', 'auto_snapshot', 'TASK-MBP-M3', 'running', '已沉淀 14 份闲鱼宝贝 10 图原始快照，幂等去重拦截 3 次撞单', ts);
  insJob.run('JOB-BG-02', 'WIN-BG-02', '后台执行窗 #2（慢慢压价低频巡检）', '闲鱼副号2', 'slow_bargain_poll', 'CONV-006', 'running', '每 48 小时自动温情跟进阿远 A7M4，零骚扰触发', ts);
  insJob.run('JOB-BG-03', 'WIN-BG-03', '后台执行窗 #3（顺丰派送盯梢秒推仓管 10m）', '闲鱼3号', 'sf_delivery_watch', 'CASE-004 / DEMO-SF-007', 'triggered_10m_sla', '检测到华硕 TUF 显示器进入「派送中」，已秒推赵仓管 10 分钟极速验货！', ts);

  // 6. 钉钉机器人（1已测通过 + 1未测通过演示防呆）
  const insBot = db.prepare(
    `INSERT INTO dingtalk_robots (id, name, webhook, secret, last_test_ok, last_test_msg, last_test_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insBot.run('BOT-01', '采购捡漏一线群机器人（已加签通过）', 'https://robot.demo.invalid/robot/01', 'demo-placeholder', 1, '本地模拟已通过（errcode=0）', ts, ts);
  insBot.run('BOT-02', '备用二组通知机器人（待测试）', 'https://robot.demo.invalid/robot/02', '', 0, '未填写 SEC 加签密钥且未连接测试', null, ts);

  // 7. 合规打招呼话术库
  const insGr = db.prepare(
    `INSERT INTO greeting_templates (greeting_type, title, text_content, created_by, created_at, updated_at)
     VALUES ('text', ?, ?, 'liming', ?, ?)`
  );
  insGr.run('个人诚心秒拍试探（礼貌不追问）', '哥你好，看到你这台自用机很爱惜，配件都还在吧？诚心想收的话包顺丰保价我今天直接拍，合适咱们核好价格就下单！', ts, ts);
  insGr.run('显示器/大件原盒顺丰询问', '老师你好，这个显示器原盒泡沫包装还在吗？我在杭州公司自己用，原盒在的话顺丰保价最稳，合适能少一点我马上下单。', ts, ts);
  insGr.run('慢慢压价长线温情铺垫', '老板不着急出没关系哈，我们长期收工作室置换下来的机器，现款直结爽快，低于预算考虑出的时候随时戳我~', ts, ts);

  // 8. 商家黑名单（互斥店铺监听与轮询自动剔除）
  const insBl = db.prepare(
    `INSERT INTO seller_blacklist (user_id, plain_user_id, nick, reason, added_by, added_at) VALUES (?, ?, ?, ?, 'liming', ?)`
  );
  insBl.run('BLK-SELLER-991', '900000000001', '华强北专业翻新老李', '历史高纠纷二道贩子：曾用换壳扩容机伪装个人自用', ts);
  insBl.run('BLK-SELLER-992', '900000000002', '暴躁哥数码', '拒绝验货且曾威胁恶意投诉小二介入', ts);

  // 9. 全域关键词监听任务（严格受行情上限与防风控校验约束）
  const insTask = db.prepare(
    `INSERT INTO monitor_listen_tasks (
       id, name, search_keyword, match_sub, exclude_keywords, seller_exclude_keywords, match_sub_price_ranges,
       price_from, price_to, division_options, sort_mode, publish_within_minutes, quick_filters,
       filter_pushed_enabled, interval_seconds, listen_account_ids, miaopai_enabled, miaopai_account_ids,
       miaopai_price_from, miaopai_price_to, dingtalk_robot_ids, greeting_enabled, greeting_template_ids,
       pricebook_sku, enabled, last_run_at, hit_count, created_by, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insTask.run(
    'TASK-MBP-M3', 'MacBook Pro 14 M3 个人自用捡漏线', 'MacBook Pro M3',
    '16+512 | M3 14寸 | 几乎全新', '坏机 | 零件 | 定金 | 租赁 | 扩容 | iCloud锁', '官方商城 | 回收宝 | 二手批发',
    JSON.stringify({ '16+512': { min: '5800', max: '7350' }, '几乎全新': { min: '5500', max: '7300' } }),
    5500, 7350, JSON.stringify(['310000', '330000']), 'publish_latest', 45,
    JSON.stringify(['filterPersonal', 'filterFreePostage']), 1, 15, JSON.stringify(['ACC-GF-01', 'ACC-GF-03']),
    1, JSON.stringify(['ACC-GF-03']), 5500, 7100, JSON.stringify(['BOT-01']), 1, JSON.stringify([1]),
    'MBP14-M3-16-512', 1, ts, 2, 'liming', ts, ts
  );
  insTask.run(
    'TASK-IP15P', 'iPhone 15 Pro 256G 国行个人单', 'iPhone 15 Pro 256',
    '国行 | 原色 | 白色 | 黑色', '美版 | 卡贴 | 有锁 | 换屏 | 拆修 | 进水', '手机靓号行',
    JSON.stringify({ '国行': { min: '3900', max: '4750' } }),
    3800, 4750, JSON.stringify([]), 'publish_latest', 30,
    JSON.stringify(['filterPersonal']), 1, 20, JSON.stringify(['ACC-GF-01', 'ACC-GF-03']),
    0, JSON.stringify([]), null, null, JSON.stringify(['BOT-01']), 1, JSON.stringify([1]),
    'IP15P-256-NAT', 1, ts, 2, 'liming', ts, ts
  );
  insTask.run(
    'TASK-ROG-2K', '27寸 2K 高刷电竞屏 急出盯梢', 'ROG 显示器 27 2K',
    '27寸 | 原盒 | 完美屏', '碎屏 | 维修配件 | 自提限同城', '',
    JSON.stringify({}),
    850, 1380, JSON.stringify([]), 'price_asc', 60,
    JSON.stringify(['filterPersonal']), 1, 25, JSON.stringify(['ACC-GF-03']),
    1, JSON.stringify(['ACC-GF-03']), 850, 1280, JSON.stringify(['BOT-01']), 1, JSON.stringify([2]),
    'ROG-XG27ACS-2K', 1, ts, 2, 'liming', ts, ts
  );

  // 10. 收藏卖家与店铺上新监听双向联动
  const insFav = db.prepare(
    `INSERT INTO favorite_sellers (seller_id, seller_nick, category_focus, visibility_scope, owner_staff_id, tags_json, notes, total_deals, shop_monitor_id, updated_at)
     VALUES (?, ?, ?, ?, 'liming', ?, ?, ?, ?, ?)`
  );
  insFav.run('SELLER-GF-001', '诚实果粉阿Ken', '苹果手机/iPad', 'team', JSON.stringify(['描述诚实', '箱说全', '团队共享']), '苏州程序员换新机频次高，上次 iPhone 15 Pro 描述极其真实', 3, 'SHOP-MON-01', ts);
  insFav.run('SELLER-GF-008', '杭州影像工作室老周', 'Sony微单/镜头', 'personal', JSON.stringify(['相机棚备用机', '快门低']), '个人私藏优质工作室卖家，换季常清备机', 2, 'SHOP-MON-02', ts);

  const insShop = db.prepare(
    `INSERT INTO monitor_shop_tasks (id, seller_user_id, seller_nick, shop_url, match_sub, exclude_keywords, price_from, price_to, pricebook_sku, listen_account_ids, miaopai_enabled, miaopai_account_ids, dingtalk_robot_ids, interval_seconds, favorite_seller_id, enabled, last_run_at, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,'liming',?,?)`
  );
  insShop.run('SHOP-MON-01', 'SELLER-GF-001', '诚实果粉阿Ken', 'https://shop.demo.invalid/personal?userId=SELLER-GF-001', 'iPhone | iPad | Mac', '手机壳 | 贴膜', 3000, 7350, 'IP15P-256-NAT', JSON.stringify(['ACC-GF-03']), 0, JSON.stringify([]), JSON.stringify(['BOT-01']), 30, 'SELLER-GF-001', ts, ts, ts);
  insShop.run('SHOP-MON-02', 'SELLER-GF-008', '杭州影像工作室老周', 'https://shop.demo.invalid/personal?userId=SELLER-GF-008', 'Sony | A7M4', '背带 | 电池单独卖', 8500, 10200, 'SONY-A7M4-BODY', JSON.stringify(['ACC-GF-01']), 0, JSON.stringify([]), JSON.stringify(['BOT-01']), 45, 'SELLER-GF-008', ts, ts, ts);

  // 11. 监控实时命中商品流（展示「几乎全新」买前防追问预警 + 预计 10% 提成）
  const nowMs = Date.now();
  const insHit = db.prepare(
    `INSERT INTO monitor_hits (
       hit_id, source_type, source_task_id, source_task_name, platform, item_id, account_id,
       title, desc_text, price_yuan, price_str, seller_user_id, seller_nick, area_text,
       publish_time_ms, pic_url, images_json, tags_json, pricebook_sku, ref_cents, ceiling_cents,
       prebuy_save_cents, prebuy_comm_cents, suspect_quality_flag, prebuy_warning,
       dingtalk_pushed, greeting_sent, linked_case_id, linked_conv_id, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insHit.run(
    'HIT-8801', 'global', 'TASK-MBP-M3', 'MacBook Pro 14 M3 个人自用捡漏线', 'goofish', 'GF-990101', 'ACC-GF-03',
    'MacBook Pro 14 M3 16+512 几乎全新 自用备用机急出',
    '去年年底官网买的，平时放桌上外接显示器，几乎全新配件盒全在，诚心要可谈价顺丰保价发出。',
    7150, '7150', 'SELLER-NEW-901', '杭州极客小陈', '浙江 杭州 余杭区',
    nowMs - 4 * 60 * 1000, '/evidence/item_mbp_m3.jpg',
    JSON.stringify(['/evidence/item_mbp_m3.jpg', '/evidence/snapshot-description.png']),
    JSON.stringify(['个人自用', '包邮', '98%买家好评']), 'MBP14-M3-16-512',
    760000, 735000, 45000, 4500, 1,
    '🎯 卖家标『几乎全新』：买前严禁多嘴追问划痕防卖家补充免责！直接锁快照打『质疑成色标』交仓管 10m 深检。',
    1, 1, null, null, ts
  );
  insHit.run(
    'HIT-8802', 'global', 'TASK-IP15P', 'iPhone 15 Pro 256G 国行个人单', 'goofish', 'GF-990102', 'ACC-GF-03',
    'iPhone 15 Pro 256G 国行原色 99新无磕碰 电池94%',
    '一直带壳贴膜使用，原装数据线盒子都在，换17 Pro腾出闲置，个人一手自用不急乱砍不回。',
    4580, '4580', 'SELLER-NEW-902', '西溪果粉阿泽', '浙江 杭州 西湖区',
    nowMs - 8 * 60 * 1000, '/evidence/item_ip15p.jpg',
    JSON.stringify(['/evidence/item_ip15p.jpg', '/evidence/snapshot-condition.png']),
    JSON.stringify(['个人一手', '包邮', '信用极好']), 'IP15P-256-NAT',
    505000, 475000, 47000, 4700, 1,
    '🎯 卖家标『99新无磕碰』：买前严禁追问边框划痕！建议按 ¥4,450–¥4,600 首探并锁 10 图快照。',
    1, 0, null, null, ts
  );
  insHit.run(
    'HIT-8803', 'shop', 'SHOP-MON-02', '店铺上新 · 杭州影像工作室老周', 'goofish', 'GF-990103', 'ACC-GF-01',
    'Sony A7M4 单机身 快门8600次 工作室备机全套',
    '棚内稳定器备机，快门实测 8600，CMOS 干净，底部贴纸边缘有两处正常上云台轻微磨痕已拍清。',
    9850, '9850', 'SELLER-GF-008', '杭州影像工作室老周', '浙江 杭州 滨江区',
    nowMs - 14 * 60 * 1000, '/evidence/item_a7m4.jpg',
    JSON.stringify(['/evidence/item_a7m4.jpg']),
    JSON.stringify(['收藏店铺', '实拍披露清晰', '包邮']), 'SONY-A7M4-BODY',
    1060000, 1020000, 75000, 7500, 0, '',
    1, 1, null, null, ts
  );
  insHit.run(
    'HIT-8804', 'global', 'TASK-ROG-2K', '27寸 2K 高刷电竞屏 急出盯梢', 'goofish', 'GF-990104', 'ACC-GF-03',
    'ROG 27寸 2K 180Hz 超频电竞显示器 充新箱说全',
    '搬家出，充新没怎么用过，原盒都在直接发顺丰，价格实惠看上的带价来聊。',
    1260, '1260', 'SELLER-NEW-904', '南京电竞哥', '江苏 南京 鼓楼区',
    nowMs - 2 * 60 * 1000, '/evidence/item_rog_2k.jpg',
    JSON.stringify(['/evidence/item_rog_2k.jpg', '/evidence/snapshot-condition.png']),
    JSON.stringify(['刚刚发布', '原盒在', '顺丰可发']), 'ROG-XG27ACS-2K',
    165000, 138000, 39000, 3900, 1,
    '🎯 卖家标『充新』且未拍通电白底测试图：买前禁追问亮斑！锁定快照直接切安全号拍下交赵仓管 10m 验亮斑。',
    1, 0, null, null, ts
  );

  // 12. 完整采购订单、会话快照与二次议价闭环样本
  const insSnap = db.prepare(
    `INSERT INTO item_snapshots (snapshot_id, product_id, version_no, seller_title, seller_declaration, pricebook_sku, pricebook_ref_version, images_json, source_type, captured_by, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'liming', ?)`
  );
  insSnap.run('SNAP-CONV001-V1', 'GF-8811801', 1, 'iPhone 15 Pro 256G 原色 24年4月激活', '国行双卡，屏幕原装零划痕，电池93%，原盒配件都在', 'IP15P-256-NAT', 2, JSON.stringify(['/evidence/item_ip15p.jpg', '/evidence/snapshot-description.png', '/evidence/snapshot-condition.png']), '监控自动锁图', ts);
  insSnap.run('SNAP-CASE003-V1', 'GF-8812034', 1, 'MacBook Pro 14 M3 16+512 几乎全新（底壳模糊）', '成色栏：几乎全新；正文：自用爱惜配件全', 'MBP14-M3-16-512', 2, JSON.stringify(['/evidence/item_mbp_m3.jpg', '/evidence/snapshot-description.png']), '买前锁死快照', ts);
  insSnap.run('SNAP-CONV007-V1', 'GF-8812707', 1, 'Sony A7M4 单机身或带 28-70 套头冲突待核', '标题单机身但正文含28-70镜头描述', 'SONY-A7M4-BODY', 2, JSON.stringify(['/evidence/item_a7m4.jpg']), '商品页多图快照', ts);

  const insConv = db.prepare(
    `INSERT INTO conversations (conv_id, account_id, product_id, bucket, seller_id, seller_nick, sku_code, title, listed_cents, ref_cents, initial_offer_cents, target_cents, ceiling_cents, agreed_cents, pause_state, context_version, pause_reason, snapshot_id, seller_attitude, ai_score, advice_summary, needs_manual, wait_minutes, unread_count, slow_group, matched_status, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insConv.run('CONV-001', 'ACC-GF-01', 'GF-8811801', 'bargaining', 'SELLER-GF-001', '诚实果粉阿Ken', 'IP15P-256-NAT', 'iPhone 15 Pro 256G 原色 充新零划痕 电池93%', 485000, 505000, 445000, 460000, 475000, 462000, 'auto', 2, null, 'SNAP-CONV001-V1', 'willing_drop', 88, '已谈妥 ¥4,620（比参考价 M ¥5,050 省 ¥430，预计买前10%提成 ¥43），待第4步核改价付款', 0, 4, 2, 0, 'matched', ts);
  insConv.run('CONV-003', 'ACC-GF-02', 'GF-8812034', 'urgent_10m', 'SELLER-GF-005', '极客小林', 'MBP14-M3-16-512', 'MacBook Pro 14 M3 16+512 几乎全新（底壳图糊）', 745000, 760000, 680000, 710000, 735000, null, 'auto', 1, null, 'SNAP-CASE003-V1', 'willing_drop', 82, '⚠️ 当前绑定闲鱼副号2(4.71%逼近红标)，建议先切闲鱼3号并打『质疑成色标』不追问拍下', 1, 6, 1, 0, 'matched', ts);
  insConv.run('CONV-006', 'ACC-GF-01', 'GF-8812606', 'slow_bargain', 'SELLER-GF-006', '阿远的器材柜', 'SONY-A7M4-BODY', 'Sony A7M4 工作室备机 快门6500 不急出', 1050000, 1060000, 950000, 980000, 1020000, null, 'auto', 1, null, null, 'firm', 84, '卖家咬住低于 ¥10,300 先挂着，已移入慢慢压价长线池每 48h 跟进', 0, 125, 0, 1, 'matched', ts);
  insConv.run('CONV-007', 'ACC-GF-02', 'GF-8812707', 'urgent_10m', 'SELLER-GF-007', '林先生的器材铺', 'SONY-A7M4-BODY', 'Sony A7M4 单机/套机描述冲突（待核）', 1120000, 1060000, 960000, 990000, 1020000, null, 'paused', 1, '标题单机身正文写含28-70套头，已暂停防误报价', 'SNAP-CONV007-V1', 'uncertain', 55, '须人工核对规格后再发首探', 1, 9, 1, 0, 'conflict_pending', ts);

  const insMsg = db.prepare(
    `INSERT INTO messages (msg_id, conv_id, sender_type, sender_name, body, offer_cents, round_no, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insMsg.run('MSG-101', 'CONV-001', 'seller', '诚实果粉阿Ken', '国行原色 256G，屏幕零划痕，挂 4850 诚心要可小刀', 485000, 1, 'seed-msg-101', ts);
  insMsg.run('MSG-102', 'CONV-001', 'buyer_ai', '合规议价助手', '哥看你机器确实爱惜，诚心收先报 4450 元看能不能聊。', 445000, 1, 'seed-msg-102', ts);
  insMsg.run('MSG-103', 'CONV-001', 'seller', '诚实果粉阿Ken', '4450 太低了，看你爽快最少 4620 我给你改价了！', 462000, 2, 'seed-msg-103', ts);
  insMsg.run('MSG-301', 'CONV-003', 'seller', '极客小林', 'MacBook Pro M3 16+512 自用几乎全新，从 7900 连降三次到 7450。', 745000, 1, 'seed-msg-301', ts);
  insMsg.run('MSG-701', 'CONV-007', 'system', '防呆拦截卫士', '⚠️ 检测到标题「单机身」与正文「带28-70套头」冲突，已暂停自动发送转人工纠偏。', null, 1, 'seed-msg-701', ts);

  const insCase = db.prepare(
    `INSERT INTO procurement_cases (
       case_id, order_bucket, lvl, title, sku_code, model_name, account_id, seller_id, seller_nick,
       conv_id, snapshot_id, pricebook_ref_version, ref_cents, target_cents, ceiling_cents,
       agreed_cents, paid_cents, prebuy_step, suspect_quality_flag, prebuy_note, seller_modified_price,
       payment_receipt_no, external_order_no, sf_waybill_no, sf_delivery_status,
       warehouse_check_state, warehouse_video_url, warehouse_defect_photos, warehouse_defect_note,
       owner_staff_id, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  // 今天采购的（4笔）
  insCase.run('CASE-003', 'today', 'red', 'MacBook Pro 14 M3 16+512（卖家写『几乎全新』图模糊 · 副号2 4.71% 待切安全号）', 'MBP14-M3-16-512', 'MacBook Pro 14 M3 16+512', 'ACC-GF-02', 'SELLER-GF-005', '极客小林', 'CONV-003', 'SNAP-CASE003-V1', 2, 760000, 710000, 735000, null, null, 2, 0, '买前不追问划痕，切安全号打质疑标拍下', 0, null, 'GF-ORD-779303', null, 'prebuy', 'pending', null, '[]', '', 'liming', ts, ts);
  insCase.run('CASE-004', 'today', 'red', '华硕 TUF 27寸 2K 240Hz 显示器（顺丰正在派送 · WIN-BG-03 秒推仓管 10m 验货）', 'ASUS-VG27AQML1A', '华硕 TUF 27寸 2K 240Hz 显示器', 'ACC-GF-01', 'SELLER-GF-003', '上海玩家大刘', null, null, 1, 135000, 105000, 112000, 105000, 105000, 5, 1, '已打质疑成色标，等待赵仓管 10m 开箱回传', 1, 'PAY-ALI-992104', 'GF-ORD-778104', 'DEMO-SF-007', 'delivering', 'delivering_10m_sla', null, '[]', '', 'liming', ts, ts);
  insCase.run('CASE-001', 'today', 'amb', 'iPhone 15 Pro 256G 国行原色（已谈妥 ¥4,620 · 第 4 步核改价再付款）', 'IP15P-256-NAT', 'iPhone 15 Pro 256G 国行原色', 'ACC-GF-01', 'SELLER-GF-001', '诚实果粉阿Ken', 'CONV-001', 'SNAP-CONV001-V1', 2, 505000, 460000, 475000, 462000, null, 4, 1, '已锁定 3 张实拍快照，待核对卖家已实际改价再登记付款', 0, null, 'GF-ORD-778001', null, 'prebuy', 'pending', null, '[]', '', 'liming', ts, ts);
  insCase.run('CASE-002', 'today', 'grn', 'Sony A7M4 单机身 快门1.1万（已高清披露掉漆 · 严守 ¥10,200 上限）', 'SONY-A7M4-BODY', 'Sony A7M4 单机身 快门<2万', 'ACC-GF-01', 'SELLER-GF-002', '杭州影像老周', null, null, 2, 1060000, 990000, 1020000, 995000, null, 3, 0, '成色披露透明，按行价上限内推进', 0, null, 'GF-ORD-778002', null, 'prebuy', 'pending', null, '[]', '', 'liming', ts, ts);

  // 二次议价 · 问题订单（6笔）
  insCase.run('CASE-005', 'issue', 'red', 'iPad Pro 11 M2 256G（派送 6m 抓 2cm 亮斑当场拒签 → 10m 确认面单拒签加微）', 'IPADP11-M2-256', 'iPad Pro 11 M2 256G 深空灰', 'ACC-GF-01', 'SELLER-GF-010', '合肥二手电子', null, null, 1, 390000, 360000, 375000, 365000, 365000, 6, 1, '买前标『几乎全新无亮斑』', 1, 'PAY-ALI-980102', 'GF-ORD-771009', 'DEMO-SF-004', 'refused_at_station', 'defect', '/evidence/unbox-sample.mp4', JSON.stringify(['/evidence/snapshot-condition.png', '/evidence/item_ipad_m2.jpg']), '顺丰派送6分钟一镜到底检出屏幕左下角 2cm 亮斑，快递员已现场标拒签', 'liming', ts, ts);
  insCase.run('CASE-011', 'issue', 'red', 'ROG 27寸 2K 电竞屏（实付 ¥1,400 · 已拒签加微 demo_seller_11 → 第 4 步半价/P3 首刀）', 'ROG-XG27ACS-2K', 'ROG 27寸 2K 180Hz 电竞显示器', 'ACC-GF-03', 'SELLER-GF-011', '合成样本卖家11', null, null, 1, 165000, 128000, 138000, 140000, 140000, 6, 1, '买前标『99新原盒无划痕』', 1, 'PAY-ALI-991811', 'GF-ORD-777311', 'DEMO-SF-005', 'refused_at_station', 'defect', '/evidence/unbox-sample.mp4', JSON.stringify(['/evidence/snapshot-condition.png', '/evidence/item_rog_2k.jpg']), '仓管 7 分钟拒签实拍：缺原厂泡沫内衬+缺 DP 线+右边框 2 处磕碰掉漆', 'liming', ts, ts);
  insCase.run('CASE-006', 'issue', 'amb', 'MacBook Pro 14 M3 16+512（实付 ¥7,200 · 卖家急问退 250 行不行 → 十二奇兵压价中）', 'MBP14-M3-16-512', 'MacBook Pro 14 M3 16+512', 'ACC-GF-01', 'SELLER-GF-004', '苏州数码工作室', null, null, 2, 760000, 710000, 735000, 720000, 720000, 6, 1, '买前未披露底壳划痕与副厂电源', 1, 'PAY-ALI-990812', 'GF-ORD-775210', 'DEMO-SF-008', 'refused_at_station', 'defect', '/evidence/unbox-sample.mp4', JSON.stringify(['/evidence/snapshot-description.png', '/evidence/item_mbp_m3.jpg']), '仓管抓出杂牌充电头（配原装 ¥80）+ 底壳 2.5cm 露白深划痕（折损 ¥220）', 'liming', ts, ts);
  insCase.run('CASE-009', 'issue', 'amb', 'Steam Deck OLED 1TB（实付 ¥3,400 · 卖家强硬打 95338 退回 · 勉强收下净赚 ¥530 vs 截回锁）', 'IPADP11-M2-256', 'Steam Deck OLED 1TB 掌机', 'ACC-GF-01', 'SELLER-GF-009', '南京强硬卖家阿强', null, null, 1, 395000, 340000, 373000, 340000, 340000, 6, 1, '买前捡漏 ¥3,400，保底净赚 ¥530', 1, 'PAY-ALI-991502', 'GF-ORD-776890', 'DEMO-SF-009', 'returning_95338', 'defect', '/evidence/unbox-sample.mp4', JSON.stringify(['/evidence/snapshot-description.png']), '右上角磕碰+背壳划痕；卖家已打 95338 退回，截回确认前锁死仓管入库！', 'liming', ts, ts);
  insCase.run('CASE-012', 'issue', 'red', '戴尔 U2723QE 27寸 4K 显示器（原单 ¥2,000 → 二次议价 ¥800 · 整单退关单+支付宝对公）', 'ROG-XG27ACS-2K', '戴尔 U2723QE 27寸 4K 专业显示器', 'ACC-GF-01', 'SELLER-GF-012', '设计师老周', null, null, 1, 165000, 128000, 152000, 200000, 200000, 6, 1, '原盒全套实付 ¥2,000', 1, 'PAY-ALI-998200', 'GF-ORD-779012', 'DEMO-SF-006', 'refused_at_station', 'defect', '/evidence/unbox-sample.mp4', JSON.stringify(['/evidence/snapshot-condition.png', '/evidence/item_dell_4k.jpg']), '纯白屏检出右侧大块发红暗斑 + 缺雷电4线，电话谈妥 ¥800 留货（省 ¥1,200！）', 'liming', ts, ts);
  insCase.run('CASE-007', 'issue', 'amb', 'Apple iMac 27寸 一体机（已登记支付宝对公 ¥850 → 待陈会计次日 10:00 T+1 审批）', 'MBP14-M3-16-512', 'Apple iMac 27寸 5K 一体机', 'ACC-GF-01', 'SELLER-GF-007X', '合成样本卖家07', null, null, 1, 175000, 125000, 145000, 139785, 139785, 6, 1, '卖家写500G固态，实测机械盘开机2分18秒', 1, 'PAY-ALI-988701', 'GF-CLOSE-20261108', 'DEMO-SF-003', 'signed_waiting_t1', 'defect', '/evidence/unbox-sample.mp4', JSON.stringify(['/evidence/snapshot-description.png']), '非标称固态硬盘（加500G固态¥345+工时¥200），已走闲鱼全退关单并登记对公 ¥850', 'liming', ts, ts);

  // 已完结（2笔）
  insCase.run('CASE-008', 'done', 'grn', 'AirPods Pro 2 USB-C（验机全对入良品库 · 买前 10% 已发）', 'IP15P-256-NAT', 'AirPods Pro 2 USB-C 国行在保', 'ACC-GF-03', 'SELLER-GF-008X', '宁波个人玩家', null, null, 2, 135000, 115000, 122000, 118000, 118000, 6, 0, '完美无瑕已上架销售库', 1, 'PAY-ALI-980808', 'GF-ORD-770808', 'DEMO-SF-002', 'delivered_ok', 'restocked_good', '/evidence/unbox-sample.mp4', '[]', '开箱成色完全一致，已入库', 'liming', ts, ts);
  insCase.run('CASE-010', 'done', 'grn', 'ROG 27寸 2K 180Hz 显示器（买前省 ¥300 拿 ¥30 + 到货谈退 ¥300 拿 ¥30 = ¥60 已发）', 'ROG-XG27ACS-2K', 'ROG 27寸 2K 180Hz 电竞显示器', 'ACC-GF-03', 'SELLER-GF-010X', '武汉电竞玩家小凯', null, null, 1, 165000, 128000, 140000, 135000, 135000, 6, 1, '两段各10%独立核算示范单', 1, 'PAY-ALI-980110', 'GF-ORD-770110', 'DEMO-SF-001', 'delivered_ok', 'restocked_good', '/evidence/unbox-sample.mp4', JSON.stringify(['/evidence/snapshot-condition.png']), '底座3cm划痕实拍进ERP供销售自取，退 ¥300 入良品库 B-02-08', 'liming', ts, ts);

  // 13. 二次议价 9 步工单（6 笔 issue + 1 笔 done 对照）
  const insTk = db.prepare(
    `INSERT INTO aftersales_tickets (
       ticket_id, case_id, arrival_track, current_step, waybill_refuse_verified,
       seller_wx_added, seller_wx_id, platform_return_locked, seller_signal, seller_signal_note,
       first_knife_mode, opening_anchor_cents, target_keep_cents, bottom_line_cents,
       salvage_profit_cents, is_salvage_profitable, tactics_used_json, sf_95338_status,
       settle_mode, agreed_reduction_cents, final_keep_cents, warehouse_disposal_status,
       finance_settled, warehouse_confirmed, status, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insTk.run('TK-2401', 'CASE-005', 'sf_express_refuse', 2, 0, 0, '', 0, '', '', 'half_price', 65000, 35000, 20000, 0, 0, '[]', 'none', 'undecided', 0, 0, 'defect_hold', 0, 0, 'open', ts);
  insTk.run('TK-2404', 'CASE-011', 'sf_express_refuse', 4, 1, 1, 'demo_seller_11', 0, 'amber_anxious', '已拒签加上微信号 demo_seller_11，准备出首刀（可选 50% 半价首刀 ¥700 或 P3 拆项精确锚 ¥450）', 'half_price', 70000, 45000, 25000, 28000, 1, '[]', 'none', 'undecided', 0, 0, 'defect_hold', 0, 0, 'open', ts);
  insTk.run('TK-2402', 'CASE-006', 'sf_express_refuse', 5, 1, 1, 'demo_seller_06', 0, 'green_proactive', '卖家急问『退250行不行，别退回来了太折腾』', 'p3_itemized', 45000, 32000, 22000, 35000, 1, JSON.stringify(['P3_ITEMIZED_ANCHOR']), 'none', 'undecided', 25000, 695000, 'defect_hold', 0, 0, 'open', ts);
  insTk.run('TK-2403', 'CASE-009', 'sf_express_refuse', 7, 1, 1, 'demo_seller_09', 0, 'red_hard_address', '卖家强硬回复：那你给我退回吧，我打 95338 已经让他退了', 'half_price', 60000, 35000, 15000, 53000, 1, JSON.stringify(['P1_SUNK_COST']), 'requested', 'undecided', 0, 0, 'defect_hold', 0, 0, 'open', ts);
  insTk.run('TK-2412', 'CASE-012', 'sf_express_refuse', 8, 1, 1, 'demo_seller_12', 0, 'green_proactive', '卖家心疼 27 寸顺丰保价且自知暗斑难出，电话口头答应 ¥800 留货（待走整单退关单+支付宝对公）', 'half_price', 140000, 120000, 85000, 120000, 1, JSON.stringify(['G3_PLAY_HARD_TO_GET', 'P5_GOOD_BAD_COP']), 'none', 'corp_alipay_close', 120000, 80000, 'defect_hold', 0, 0, 'open', ts);
  insTk.run('TK-SAMPLE', 'CASE-007', 'signed_platform_return', 9, 0, 1, 'demo_seller_07', 1, 'green_proactive', '已完成闲鱼整单退关单，已提交演示收款人07(payee07@example.invalid)对公打款 ¥850 登记单', 'p3_itemized', 65000, 54785, 35000, 54785, 1, JSON.stringify(['G1_LEMON_MARKET', 'G6_THREE_CONTRACTS']), 'none', 'corp_alipay_close', 54785, 85000, 'waiting_inbound_confirm', 0, 0, 'waiting_finance', ts);
  insTk.run('TK-2409', 'CASE-010', 'signed_platform_return', 9, 0, 1, 'demo_seller_10', 1, 'green_proactive', '买前省 ¥300 + 到货谈退 ¥300，钱货双清完结', 'p3_itemized', 45000, 30000, 20000, 30000, 1, JSON.stringify(['P3_ITEMIZED_ANCHOR', 'G2_SIGNALING_REINFORCE']), 'none', 'platform_partial', 30000, 105000, 'restocked_good', 1, 1, 'done', ts);

  db.prepare(
    `INSERT INTO aftersales_bargain_logs (log_id, ticket_id, round_no, speaker, tactic_code, offer_cents, content, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
  ).run('BLOG-101', 'TK-2402', 'buyer_liming', 'P3_ITEMIZED', 45000, '杂牌充电头+底壳 2.5cm 露白深划痕，补 ¥450 勉强收下（沉默 6 秒）', ts);
  db.prepare(
    `INSERT INTO aftersales_bargain_logs (log_id, ticket_id, round_no, speaker, tactic_code, offer_cents, content, created_at)
     VALUES (?, ?, 2, ?, ?, ?, ?, ?)`
  ).run('BLOG-102', 'TK-2402', 'seller', 'OFFER', 25000, '退 ¥250 行不行别退回来了，邮费来回折腾……', ts);

  // 14. T+1 支付宝对公支付登记单（TK-SAMPLE）
  db.prepare(
    `INSERT INTO corp_alipay_registrations (reg_id, ticket_id, case_id, payee_real_name, payee_alipay_account, amount_cents, wx_contract_confirmed, status, schedule_slot, created_by, created_at)
     VALUES ('ALIPAY-REG-1001', 'TK-SAMPLE', 'CASE-007', '演示收款人07', 'payee07@example.invalid', 85000, 1, 'pending_finance', '次日 10:00 (T+1)', 'liming', ?)`
  ).run(ts);

  // 15. 次日 10:00 前昨日财务对账单（8笔：5已匹配 + 2漏单 ST-06/ST-07 + 1保价差额 ST-08）
  db.prepare(
    `INSERT INTO statement_batches (batch_id, title, statement_date, sync_source_label, status, created_at)
     VALUES ('STMT-20261118', '昨日对账单（昨日全天企业支付宝与闲鱼绑定扣款流水）', '昨日全天', '今日 09:25 自动同步到位（次日 10:00 前财务账单接口推入）', 'open_diff', ?)`
  ).run(ts);

  const insSt = db.prepare(
    `INSERT INTO statement_items (item_id, batch_id, alipay_tx_no, external_order_no, account_name, seller_nick, item_title, sku_code, statement_amount_cents, system_amount_cents, diff_type, resolution_state, linked_case_id, note, paid_at_label, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insSt.run('ST-01', 'STMT-20261118', 'PAY-ALI-992104', 'GF-ORD-778104', '闲鱼主号1', '上海玩家大刘', '华硕 TUF 27寸 2K 240Hz 显示器', 'ASUS-VG27AQML1A', 105000, 105000, 'matched', 'auto', 'CASE-004', '金额完全一致', '昨日 10:15', ts);
  insSt.run('ST-02', 'STMT-20261118', 'PAY-ALI-991811', 'GF-ORD-777311', '闲鱼3号', '合成样本卖家11', 'ROG 27寸 2K 电竞显示器 99新原盒', 'ROG-XG27ACS-2K', 140000, 140000, 'matched', 'auto', 'CASE-011', '金额完全一致', '昨日 11:42', ts);
  insSt.run('ST-03', 'STMT-20261118', 'PAY-ALI-998200', 'GF-ORD-779012', '闲鱼主号1', '设计师老周', '戴尔 U2723QE 27寸 4K 显示器', 'ROG-XG27ACS-2K', 200000, 200000, 'matched', 'auto', 'CASE-012', '金额完全一致', '昨日 14:08', ts);
  insSt.run('ST-04', 'STMT-20261118', 'PAY-ALI-990812', 'GF-ORD-775210', '闲鱼主号1', '苏州数码工作室', 'MacBook Pro 14 M3 16+512 98新', 'MBP14-M3-16-512', 720000, 720000, 'matched', 'auto', 'CASE-006', '金额完全一致', '昨日 16:30', ts);
  insSt.run('ST-05', 'STMT-20261118', 'PAY-ALI-991502', 'GF-ORD-776890', '闲鱼主号1', '南京强硬卖家阿强', 'Steam Deck OLED 1TB 掌机', 'IPADP11-M2-256', 340000, 340000, 'matched', 'auto', 'CASE-009', '金额完全一致', '昨日 17:55', ts);
  insSt.run('ST-06', 'STMT-20261118', 'PAY-ALI-999501', 'GF-ORD-779501', '闲鱼主号1', '西湖果粉小陆', 'iPhone 15 Pro 256G 国行白色 几乎全新（昨夜拍下漏抓单）', 'IP15P-256-NAT', 458000, null, 'missing_order', 'pending', null, '账单实扣 ¥4,580 但工作台无采购单！须一键补抓推仓管重点深检', '昨日 19:18', ts);
  insSt.run('ST-07', 'STMT-20261118', 'PAY-ALI-999588', 'GF-ORD-779588', '闲鱼副号2', '深圳电竞老K', 'ROG 27寸 2K 180Hz 电竞显示器 原盒全套（副号漏同步）', 'ROG-XG27ACS-2K', 128000, null, 'missing_order', 'pending', null, '副号拍下未回传系统！须一键补抓生成采购单', '昨日 21:46', ts);
  insSt.run('ST-08', 'STMT-20261118', 'PAY-ALI-980102', 'GF-ORD-771009', '闲鱼主号1', '合肥二手电子', 'iPad Pro 11 M2 256G 深空灰（含代付顺丰保价费 ¥15）', 'IPADP11-M2-256', 366500, 365000, 'amount_diff', 'pending', 'CASE-005', '财务实扣 ¥3,665 vs 系统记 ¥3,650（差 +¥15 顺丰保价费）', '昨日 15:10', ts);

  // 16. 财务流水 & 两段各 10% 提成样本（严禁把 R 代回买前重算！）
  const insLed = db.prepare(
    `INSERT INTO finance_ledger (ledger_id, case_id, ticket_id, entry_type, title, amount_cents, direction, receipt_no, verified_by, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  insLed.run('FIN-1001', 'CASE-007', 'TK-SAMPLE', 'platform_refund', '闲鱼整单全额退回关单（脱离平台管辖）', 139785, 'inflow', 'REF-GF-8801', 'chenkj', 'verified', ts);
  insLed.run('FIN-1002', 'CASE-007', 'TK-SAMPLE', 'corp_alipay_payout', '支付宝对公直转卖家张哲（T+1次日10:00审批）', 85000, 'outflow', null, null, 'pending_finance', ts);
  insLed.run('FIN-1003', 'CASE-006', 'TK-2402', 'po_payment', 'MacBook Pro M3 买前实付货款', 720000, 'outflow', 'PAY-ALI-990812', 'chenkj', 'verified', ts);
  insLed.run('FIN-1004', 'CASE-010', 'TK-2409', 'po_payment', 'ROG 显示器原单实付货款', 135000, 'outflow', 'PAY-ALI-980110', 'chenkj', 'verified', ts);
  insLed.run('FIN-1005', 'CASE-010', 'TK-2409', 'arrival_refund', '到货二次议价退回折让差价', 30000, 'inflow', 'REF-ROG-300', 'chenkj', 'verified', ts);

  const insCom = db.prepare(
    `INSERT INTO commissions (comm_id, staff_id, case_id, ticket_id, policy_mode, base_saved_cents, estimated_cents, confirmed_cents, paid_cents, status, note, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insCom.run('COM-006-PRE', 'liming', 'CASE-006', null, 'pre_buy_10_pct', 40000, 4000, 4000, 0, 'confirmed', '买前省 ¥400（M ¥7,600 - P ¥7,200）× 10% = ¥40（到货谈退绝不回代重算）', ts);
  insCom.run('COM-006-POST', 'liming', 'CASE-006', 'TK-2402', 'post_arrival_10_pct', 25000, 2500, 0, 0, 'estimated', '到货目前卖家松口 ¥250 × 10% = ¥25（预计）', ts);
  insCom.run('COM-010-PRE', 'liming', 'CASE-010', null, 'pre_buy_10_pct', 30000, 3000, 3000, 3000, 'paid', 'ROG 买前省 ¥300 × 10% = ¥30 已发放', ts);
  insCom.run('COM-010-POST', 'liming', 'CASE-010', 'TK-2409', 'post_arrival_10_pct', 30000, 3000, 3000, 3000, 'paid', 'ROG 到货谈退 ¥300 × 10% = ¥30 已发放（两段共 ¥60 独立入账）', ts);
  insCom.run('COM-012-POST', 'liming', 'CASE-012', 'TK-2412', 'post_arrival_10_pct', 120000, 12000, 0, 0, 'estimated', '戴尔 4K 2000 砍至 800（省 ¥1,200）× 10% = 预计 ¥120（等T+1对公+入库双清后转确认）', ts);
}
