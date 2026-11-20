"""从空库生成可交互的虚构数据。所有标识采用演示前缀，域名与 IP 保留为文档用途。"""
from datetime import date, timedelta


def insert(conn, table, **row):
    columns = ', '.join(row)
    placeholders = ', '.join('?' for _ in row)
    conn.execute(f'INSERT INTO {table} ({columns}) VALUES ({placeholders})', tuple(row.values()))


def seed_database(conn):
    today = date.today()
    for suffix, display in [('a', '甲'), ('b', '乙')]:
        customer = f'lp-demo-{suffix}'
        insert(conn, 'legal_persons', id=customer, name=f'演示客户{display}',
               id_card_no=f'DEMO-PERSON-{suffix.upper()}', primary_phone=f'DEMO-PHONE-{suffix.upper()}',
               residence_city='演示城市', agency_contract_no=f'DEMO-CONTRACT-{suffix.upper()}',
               contract_expires_at=str(today + timedelta(days=365)))
        insert(conn, 'carrier_quotas', id=f'cq-demo-{suffix}', legal_person_id=customer,
               holder_name=f'演示客户{display}', holder_id_card=f'DEMO-PERSON-{suffix.upper()}',
               carrier='中国移动', existing_personal_cards=1)
        for j in range(1, 5):
            sim = f'sim-{j:02}' if suffix == 'a' else f'sim-b-{j:02}'
            insert(conn, 'sim_cards', id=sim, legal_person_id=customer,
                   phone_number=f'DEMO-SIM-{suffix.upper()}-{j:02}', carrier='中国移动',
                   card_category='company_master' if j == 1 else 'company_sub',
                   real_name_holder=f'演示客户{display}', region_city='演示城市', iccid='',
                   master_sim_id=None if j == 1 else ('sim-01' if suffix == 'a' else 'sim-b-01'),
                   billing_mode='independent' if j == 1 else 'shared_master', balance_fen=2800 * j,
                   monthly_rent_fen=2800, custodian_staff='演示员工甲')
        for j in range(1, 5 if suffix == 'a' else 2):
            eid = f'ent-demo-{suffix}-{j:02}'
            sim = f'sim-{j:02}' if suffix == 'a' else f'sim-b-{j:02}'
            insert(conn, 'business_entities', id=eid, legal_person_id=customer,
                   entity_code=f'DEMO-ENTITY-{suffix.upper()}-{j:02}', entity_name=f'演示主体{display}{j}',
                   uscc=f'DEMO-USCC-{suffix.upper()}-{j:02}', entity_type='individual_business',
                   registration_authority='演示登记机关', established_date=str(today - timedelta(days=365)),
                   registered_address='演示城市示例路（合成）', target_store_slots=4)
            insert(conn, 'tax_registrations', id=f'tax-demo-{suffix}-{j:02}', business_entity_id=eid,
                   tax_bureau_name='演示税务机关', taxpayer_type='小规模纳税人', collection_mode='查账征收',
                   filing_cycle='按季申报', tax_officer_name='演示办税员', bound_sim_id=sim,
                   next_due_date=str(today + timedelta(days=45)), quarter_sales_fen=1000000 * j)
            insert(conn, 'annual_reports', id=f'ar-demo-{suffix}-{j:02}', business_entity_id=eid,
                   report_year=today.year - 1, aic_bureau_name='演示登记机关', liaison_name='演示联络员',
                   liaison_sim_id=sim, report_status='publicized', submitted_date=str(today - timedelta(days=65)))
            accounts = 4 if suffix == 'a' and j <= 2 else 3
            for k in range(accounts):
                seq = (0, 4, 8, 11)[j - 1] + k + 1
                aid = f'ali-{seq:02}' if suffix == 'a' else f'ali-{seq + 17:02}'
                master = f'ali-{seq-k:02}' if suffix == 'a' else 'ali-18'
                direction = ('master_fund', 'sales_only', 'purchase_only', 'sales_only')[k]
                insert(conn, 'alipay_accounts', id=aid, legal_person_id=customer, business_entity_id=eid,
                       account_code=f'DEMO-{aid.upper()}', account_name=f'演示企业支付 {display}{j}-{k+1}',
                       login_email=f'{aid}@example.invalid', alipay_uid=f'DEMO-UID-{aid.upper()}',
                       trade_direction=direction, is_entity_master_fund=int(k == 0),
                       corporate_pay_enabled=int(k == 2), master_alipay_id=master if k == 2 else None,
                       bound_sim_id=sim, finance_book_code=f'DEMO-BOOK-{aid.upper()}', balance_fen=125000 + 1000 * j,
                       cert_sign_mode='离线演示', bill_sync_status='手工导账单')
    for j, balance in [(12, 2000), (14, 3500), (16, 900)]:
        sim = f'sim-{j:02}'
        insert(conn, 'sim_cards', id=sim, legal_person_id='lp-demo-a', phone_number=f'DEMO-SIM-A-{j:02}',
               carrier='中国联通', card_category='external_contract' if j == 12 else 'personal_existing',
               real_name_holder='演示客户甲', region_city='演示城市', is_external=int(j == 12), balance_fen=balance,
               contract_end_date=str(today + timedelta(days=8)) if j == 12 else '',
               sim_status='contract_expiring' if j == 12 else 'active')
    insert(conn, 'sim_fee_records', id='fee-demo-01', sim_card_id='sim-16', occurred_date=str(today),
           change_type='monthly_rent', amount_fen=-2800, balance_after_fen=900, operator_name='演示员工甲')
    for j in range(1, 18):
        insert(conn, 'proxy_ips', id=f'px-{j:02}',
               proxy_code=f'DEMO-PROXY-{j:02}', provider='演示代理服务', isp_region='演示网络区',
               host=f'proxy-{j:02}.example.invalid', port=1080, proxy_user='', proxy_pass='', exit_ip=f'192.0.2.{j}',
               purchased_at=str(today - timedelta(days=20)), expires_at=str(today + timedelta(days=2 if j == 12 else 22)),
               connectivity_status='expiring' if j == 12 else 'online')
    for j in range(1, 11):
        insert(conn, 'physical_devices', id=f'dev-pc-{j:02}', device_code=f'DEMO-MAC-{j:02}',
               device_kind='adspower_pc_host', brand_model='Mac Pro 64 GB 演示机型', serial_number=f'DEMO-HOST-SERIAL-{j:02}',
               role_isolation='host_cluster', workstation_loc=f'演示机架 {j:02}', custodian_staff='演示开店主管')
    for j in range(1, 4):
        insert(conn, 'physical_devices', id=f'dev-demo-phone-{j:02}', legal_person_id='lp-demo-a',
               device_code=f'DEMO-DEVICE-{j:02}', device_kind='procurement_phone' if j == 3 else 'work_phone',
               brand_model='演示 Android 工作机', serial_number=f'DEMO-PHONE-SERIAL-{j:02}',
               role_isolation='purchase_only' if j == 3 else 'sales_only', sim_slot_1_id='sim-12' if j == 1 else None,
               workstation_loc='演示办公点', custodian_staff='演示员工甲')
    for j in range(1, 16):
        px = f'px-{j:02}' if j < 15 else 'px-17'
        cust = 'a' if j < 15 else 'b'
        entity_idx = min(4, (j - 1) // 4 + 1) if j < 15 else 1
        aid = f'ali-{(2, 6, 10, 13)[entity_idx - 1]:02}' if j < 15 else 'ali-19'
        eid = f'ent-demo-{cust}-{entity_idx:02}'
        ads = f'ads-demo-{j:02}'
        insert(conn, 'adspower_profiles', id=ads, profile_code=f'DEMO-WINDOW-{j:02}',
               ads_serial_no=f'DEMO-SERIAL-{j:02}', ads_user_id=f'demo-window-{j:02}',
               window_name=f'演示销售窗口 {j:02}', group_name='演示店铺组', host_device_id=f'dev-pc-{(j-1)//3+1:02}',
               proxy_ip_id=px, role_isolation='sales_only')
        insert(conn, 'platform_accounts', id=f'pa-xy-{j:02}' if j < 15 else 'pa-demo-b-xy02',
               legal_person_id=f'lp-demo-{cust}', business_entity_id=eid, platform='xianyu', account_code=f'DEMO-SHOP-{j:02}',
               display_name=f'演示闲鱼店 {j:02}', platform_login_id=f'demo-shop-{j:02}', account_role='sales_only',
               bound_sim_id='sim-12' if j == 12 else ('sim-01' if j < 15 else 'sim-b-01'), alipay_account_id=aid,
               adspower_profile_id=ads, proxy_ip_id=px, physical_device_id='dev-demo-phone-01' if j == 12 else None,
               merchant_account_no=f'DEMO-MERCHANT-{j:02}', operator_staff='演示员工甲' if j < 10 else '演示员工乙',
               finance_book_code=f'DEMO-SALES-BOOK-{j:02}', commission_rate_bps=60 if j < 9 else 160,
               month_gmv_fen=100000 * j, month_cost_fen=50000 * j, month_refund_fen=1000 * j,
               account_status='warming' if j in (14, 15) else 'active')
    sales_channels = {'wechat_shop': 'wechat_pay_mch', 'xiaohongshu_shop': 'xhs_merchant',
                      'doudian': 'douyin_pay_mch', 'jd_store': 'jd_wallet_mch', 'taobao_store': 'alipay_direct'}
    plats = ('wechat_shop', 'xiaohongshu_shop', 'xiaohongshu_mkt', 'wechat', 'doudian', 'taobao_store',
             'jd_store', 'dianping', 'douyin', 'doushengsheng', 'taobao_buyer', 'jd_buyer')
    for j, platform in enumerate(plats, 1):
        role = 'sales_only' if platform in sales_channels else 'marketing_only' if platform in ('wechat', 'xiaohongshu_mkt') else 'purchase_only'
        insert(conn, 'platform_accounts', id=f'pa-demo-{platform}', legal_person_id='lp-demo-a',
               business_entity_id='ent-demo-a-01', platform=platform, account_code=f'DEMO-CHANNEL-{j:02}',
               display_name=f'演示渠道 {platform}', platform_login_id=f'demo-{platform}', account_role=role,
               bound_sim_id='sim-02', alipay_account_id='ali-03' if role == 'purchase_only' else 'ali-02' if role == 'sales_only' else None,
               proxy_ip_id='px-01', physical_device_id='dev-demo-phone-03' if role == 'purchase_only' else None,
               settlement_channel=sales_channels.get(platform, 'corporate_pay_deduct' if role == 'purchase_only' else 'no_settlement'),
               finance_book_code=f'DEMO-CHANNEL-BOOK-{j:02}', operator_staff='演示员工甲')
    for j, (direction, amount, status) in enumerate([('inflow_sales', 6800, 'matched'), ('outflow_corporate_pay', 2400, 'pending')], 1):
        insert(conn, 'alipay_bills', id=f'bill-demo-{j:02}', bill_date=str(today), business_entity_id='ent-demo-a-01',
               alipay_account_id='ali-02' if j == 1 else 'ali-03', flow_direction=direction,
               biz_scene='离线对账演示', counterparty='演示交易方', platform_order_ref=f'DEMO-ORDER-{j:02}',
               amount_fen=amount, reconcile_status=status)
