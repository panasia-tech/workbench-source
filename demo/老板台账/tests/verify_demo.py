#!/usr/bin/env python3
"""在独立临时运行目录验证离线台账的主要入口和规则。"""
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT))
from vault_security import compute_totp


@contextmanager
def server(runtime):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    env.pop('LEDGER_VAULT_KEK_HEX', None)
    env.update(PYTHONDONTWRITEBYTECODE='1', LEDGER_PORT=str(port),
               LEDGER_DB_PATH=str(runtime / 'test.sqlite'), LEDGER_KEK_PATH=str(runtime / 'test.key'))
    with (runtime / 'server.log').open('ab') as log:
        process = subprocess.Popen([sys.executable, '-u', str(ROOT / 'ledger_server.py')],
                                   env=env, stdout=log, stderr=log)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(40):
                try:
                    if request(base, '/api/health')[0] == 200:
                        break
                except (URLError, ConnectionError):
                    if process.poll() is not None:
                        raise RuntimeError('应用启动失败') from None
                    time.sleep(0.1)
            else:
                raise RuntimeError('应用启动超时')
            yield base
        finally:
            process.terminate()
            process.wait(timeout=5)


def request(base, path, body=None, token=None):
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    if token:
        headers['X-Vault-Token'] = token
    req = Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urlopen(req, timeout=3) as response:
            content = response.read()
            return response.status, json.loads(content) if response.headers.get_content_type() == 'application/json' else content
    except HTTPError as response:
        return response.code, json.load(response)


def bootstrap(base, role):
    status, body = request(base, f'/api/bootstrap?role={role}')
    assert status == 200 and body['ok']
    return body['data']


def main():
    with tempfile.TemporaryDirectory(prefix='ledger-demo-check-') as tmp:
        runtime = Path(tmp)
        # 32 字节二进制密钥含首尾空白，读取时也必须完整保留。
        key_path = runtime / 'test.key'
        key_path.write_bytes(b'\n' + os.urandom(30) + b'\t')
        key_path.chmod(0o600)
        with server(runtime) as base:
            for path, marker in [('/', b'portal-tab'), ('/app.js', b'bootstrap'), ('/styles.css', b'--')]:
                status, body = request(base, path)
                assert status == 200 and marker in body
            boss = bootstrap(base, 'boss')
            employee = bootstrap(base, 'employee')
            gm = bootstrap(base, 'gm_office')
            supervisor = bootstrap(base, 'supervisor')
            assert len(boss['legal_persons']) == 2 and len(boss['platform_accounts']) == 27
            assert len(boss['cluster_health']['mac_hosts']) == 10 and all(rule['passed'] for rule in boss['guardrails'])
            assert len(boss['dispatch_capacity_policies']) == 4
            assert not employee['legal_persons'] and 0 < len(employee['onboarding_cases']) < len(boss['onboarding_cases'])
            assert not gm['legal_persons'] and gm['governance']
            assert supervisor['legal_persons'] and not supervisor['dispatch_capacity_policies']
            for case_id, step, upstream in [('case-plat-pa-demo-b-xy02', 'S09', 'C10'), ('case-plat-pa-xy-14', 'S18', 'D15')]:
                status, body = request(base, f'/api/onboarding/case?id={case_id}')
                assert status == 200 and body['data']['current_step_code'] == step and upstream in body['data']['cross_blocked_msg']
                status, body = request(base, '/api/onboarding/submit-step', {'case_id': case_id, 'step_code': step,
                                       'materials': {'proof': '演示确认'}, 'confirmed': True, 'viewer_role': 'employee'})
                assert status == 400 and upstream in body['error']
            gid = 'gov-demo-account_ops-video'
            for role, expected in [('employee', 403), ('gm_office', 200), ('boss', 200)]:
                status, _ = request(base, '/api/governance/review', {'id': gid, 'verdict': 'approve', 'viewer_role': role})
                assert status == expected
            status, body = request(base, '/api/governance/item?id=' + gid)
            assert status == 200 and body['data']['status'] == 'published'
            status, body = request(base, '/api/tutorials/template?id=tpl-alipay-ent')
            steps = [step for stage in body['data']['stages'] for step in stage['steps']]
            assert status == 200 and len(steps) == 15
            assert next(step['video_url'] for step in steps if step['step_code'] == 'C10').startswith('https://resources.example.invalid/')
            status, body = request(base, '/api/export/proxy_ips.csv')
            assert status == 200 and b'proxy-01.example.invalid' in body
            status, _ = request(base, '/api/vault/reveal', {'id': 'cred-ali-01'})
            assert status == 401
            status, body = request(base, '/api/vault/setup-qr')
            assert status == 200 and '<svg' in body['data']['qr_svg']
            secret = body['data']['secret_b32']
            status, body = request(base, '/api/vault/unlock-totp', {'code': compute_totp(secret)})
            assert status == 200 and body.get('token')
            token = body['token']
            status, body = request(base, '/api/vault/reveal', {'id': 'cred-ali-01'}, token=token)
            assert status == 200 and body['secret']['login_password'].startswith('DEMO-')
            status, _ = request(base, '/api/vault/lock', {}, token=token)
            assert status == 200
            assert request(base, '/api/vault/reveal', {'id': 'cred-ali-01'}, token=token)[0] == 401
            status, body = request(base, '/api/adspower/open-window', {'adspower_profile_id': 'ads-demo-01'})
            assert status == 200 and body['data']['live_client'] is False
        with sqlite3.connect(runtime / 'test.sqlite') as database:
            assert list(database.execute('PRAGMA foreign_key_check')) == []
            assert database.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        with server(runtime) as base:
            status, body = request(base, '/api/vault/setup-qr')
            assert status == 200 and body['data']['secret_b32'] == secret
            assert len(bootstrap(base, 'boss')['platform_accounts']) == 27
    print('通过：四角色、双轨硬闸、两级治理审核、CSV、TOTP、AdsPower 离线反馈、SQLite 完整性和重启持久化。')


if __name__ == '__main__':
    main()
