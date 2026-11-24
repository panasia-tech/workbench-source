#!/usr/bin/env python3
# 销售工作台本地 H5，静态文件和本地 Demo API。
import http.server, socketserver, os, sys, json, sqlite3, urllib.request, urllib.error, urllib.parse
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import cs_api
import tutorial_ledger_api
import virt_intel_api
ROOT = os.path.join(HERE, 'dist')
BACKEND = f"http://127.0.0.1:{int(os.environ.get('STITCH_DEMO_PORT', '5342'))}"
BOOKOFF_DB = os.path.join(HERE, ".demo-runtime", "bookoff-demo-sample.sqlite")
PORT = int(os.environ.get('H5_PORT', '5341'))


def _bookoff_path():
    return BOOKOFF_DB if os.path.isfile(BOOKOFF_DB) else ""


def _bookoff_conn():
    path = _bookoff_path()
    if not path: return None
    con = sqlite3.connect('file:' + path + '?mode=ro&immutable=1', uri=True)
    con.row_factory = sqlite3.Row
    return con

_bookoff_stats_cache = None
def bookoff_stats():
    global _bookoff_stats_cache
    if _bookoff_stats_cache is not None: return _bookoff_stats_cache
    con = _bookoff_conn()
    if not con: return None
    try:
        total = con.execute('select count(*) from products').fetchone()[0]
        cats = [dict(name=r[0], n=r[1]) for r in con.execute('select category,count(*) from products group by category order by 2 desc')]
        pcount = con.execute('select count(*) from products where price_yen is not null').fetchone()[0]
        med = con.execute('select price_yen from products where price_yen is not null order by price_yen limit 1 offset ?', (max(0, pcount // 2),)).fetchone()
        stock = con.execute("select count(*) from products where stock='in_stock'").fetchone()[0]
        genres = [dict(name=r[0], n=r[1]) for r in con.execute("select genre,count(*) from products where genre is not null and genre<>'' group by genre order by 2 desc limit 24")]
        with_image = con.execute("select count(*) from products where image_url not like '%item_ll.png'").fetchone()[0]
        tree_total = 0; leaf_total = 0
        try:
            import json as _j
            td = _j.load(open(os.path.join(HERE, 'dist', 'data', 'bookoff-categories.json'), encoding='utf-8'))
            tree_total = td.get('categoryCount') or 0; leaf_total = td.get('leafCount') or 0
        except Exception:
            pass
        _bookoff_stats_cache = {'total': total, 'categories': cats, 'genres': genres, 'treeTotal': tree_total, 'leafTotal': leaf_total, 'withImage': with_image, 'median': med[0] if med else None, 'inStock': stock, 'snapshot': '合成 Demo', 'sample': 'sample' in os.path.basename(_bookoff_path())}
        return _bookoff_stats_cache
    finally:
        con.close()

def bookoff_search(params):
    con = _bookoff_conn()
    if not con: return None
    try:
        q = (params.get('q') or [''])[0].strip()
        cat = (params.get('category') or [''])[0].strip()
        genre = (params.get('genre') or [''])[0].strip()
        img = (params.get('img') or ['real'])[0].strip()
        minp = (params.get('min') or [''])[0].strip()
        maxp = (params.get('max') or [''])[0].strip()
        sort = (params.get('sort') or ['rel'])[0]
        page = max(1, int((params.get('page') or ['1'])[0] or 1))
        size = min(60, max(1, int((params.get('size') or ['24'])[0] or 24)))
        where = []; args = []
        if cat: where.append('p.category = ?'); args.append(cat)
        if genre: where.append('p.genre = ?'); args.append(genre)
        if img != 'all': where.append("p.image_url not like '%item_ll.png'")
        if minp:
            try: where.append('p.price_yen >= ?'); args.append(float(minp))
            except: pass
        if maxp:
            try: where.append('p.price_yen <= ?'); args.append(float(maxp))
            except: pass
        wsql = (' and ' + ' and '.join(where)) if where else ''
        order = {'price_asc': 'p.price_yen asc', 'price_desc': 'p.price_yen desc', 'new': 'p.release_date desc'}.get(sort, 'p.id desc')
        fts_order = {'price_asc': 'p.price_yen asc', 'price_desc': 'p.price_yen desc', 'new': 'p.release_date desc'}.get(sort, 'rank')
        offset = (page - 1) * size
        if q:
            phrase = '"' + q.replace('"', ' ') + '"'
            fts_where = ['search match ?']; fts_args = [phrase]
            if where: fts_where.append(' and '.join(where)); fts_args += args
            sql = 'select p.* from search s join products p on p.id=s.rowid where ' + ' and '.join(fts_where) + ' order by ' + fts_order + ' limit ? offset ?'
            try:
                rows = con.execute(sql, fts_args + [size, offset]).fetchall()
            except sqlite3.OperationalError:
                rows = []
            if not rows:
                like = '%' + q + '%'
                sql2 = 'select p.* from products p where (p.title like ? or p.author like ?)' + wsql + ' order by ' + order + ' limit ? offset ?'
                rows = con.execute(sql2, [like, like] + args + [size, offset]).fetchall()
                total = con.execute('select count(*) from products p where (p.title like ? or p.author like ?)' + wsql, [like, like] + args).fetchone()[0]
            else:
                try:
                    total = con.execute('select count(*) from search s join products p on p.id=s.rowid where ' + ' and '.join(fts_where), fts_args).fetchone()[0]
                except sqlite3.OperationalError:
                    total = offset + len(rows)
        else:
            sql = 'select p.* from products p where 1=1' + wsql + ' order by ' + order + ' limit ? offset ?'
            rows = con.execute(sql, args + [size, offset]).fetchall()
            total = con.execute('select count(*) from products p where 1=1' + wsql, args).fetchone()[0]
        return {'total': total, 'page': page, 'size': size, 'items': [dict(r) for r in rows]}
    finally:
        con.close()

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def proxy(self):
        url = BACKEND + self.path
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else None
        req = urllib.request.Request(url, data=body, method=self.command)
        for k in ('Authorization', 'Content-Type', 'Accept', 'Accept-Language'):
            v = self.headers.get(k)
            if v:
                req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                data = r.read()
                self.send_response(r.status)
                ct = r.headers.get('Content-Type', 'application/json')
                self.send_header('Content-Type', ct)
                cl = r.headers.get('Content-Length') if self.command == 'HEAD' else str(len(data))
                if cl is not None:
                    self.send_header('Content-Length', str(cl))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header('Content-Type', e.headers.get('Content-Type', 'application/json'))
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            msg = ('{"detail":"演示后端没连上：%s"}' % str(e).replace('"', "'")).encode('utf-8')
            self.send_response(502)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def _bookoff(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)
        if path == '/api/bookoff/stats':
            data = bookoff_stats()
        elif path == '/api/bookoff/search':
            data = bookoff_search(params)
        else:
            data = None
        if data is None:
            msg = json.dumps({'detail': '本地商品样例未初始化'}, ensure_ascii=False).encode('utf-8')
            self.send_response(503); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(msg))); self.end_headers(); self.wfile.write(msg)
            return True
        msg = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(200); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(msg))); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(msg)
        return True

    def _handle_cs(self):
        parsed_path = urllib.parse.unquote(urlparse(self.path).path)
        if parsed_path != '/cs-build.txt' and not parsed_path.startswith('/api/cs/'):
            return False
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n > 0 else b''
        res = cs_api.handle_cs_request(self.command, self.path, self.headers, body)
        if res is None:
            return False
        code, ctype, raw = res
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(raw)
        return True

    def _handle_tutorials(self):
        parsed_path = urllib.parse.unquote(urlparse(self.path).path)
        if not parsed_path.startswith('/api/tutorials/'):
            return False
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n > 0 else b''
        res = tutorial_ledger_api.handle_tutorial_request(self.command, self.path, self.headers, body)
        if res is None:
            return False
        code, ctype, raw = res
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(raw)
        return True

    def _handle_virt_intel(self):
        parsed_path = urllib.parse.unquote(urlparse(self.path).path)
        if not parsed_path.startswith('/api/virt-intel/'):
            return False
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n > 0 else b''
        res = virt_intel_api.handle_virt_intel_request(self.command, self.path, self.headers, body)
        if res is None:
            return False
        code, ctype, raw = res
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(raw)
        return True

    def do_GET(self):
        if self._handle_virt_intel():
            return
        if self._handle_tutorials():
            return
        if self._handle_cs():
            return
        if self.path.startswith('/api/bookoff/'):
            return self._bookoff()
        if self.path.startswith('/api/'):
            return self.proxy()
        if self.path.startswith('/files/'):
            self.path = '/api/demo-files' + self.path.removeprefix('/files')
            return self.proxy()
        path = self.translate_path(self.path)
        if not os.path.exists(path) or os.path.isdir(path):
            self.path = '/index.html'
        self._send_no_cache = self.path.startswith('/index.html') or '?' in self.path or not self.path.startswith('/assets/')
        return super().do_GET()

    def end_headers(self):
        if getattr(self, '_send_no_cache', False):
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self._send_no_cache = False
        super().end_headers()

    def do_HEAD(self):
        if self.path.startswith('/api/bookoff/'):
            return self._bookoff()
        if self.path.startswith('/api/'):
            return self.proxy()
        return super().do_HEAD()

    def do_POST(self):
        if self._handle_virt_intel():
            return
        if self._handle_tutorials():
            return
        if self._handle_cs():
            return
        if self.path.startswith('/api/'):
            return self.proxy()
        self.send_error(405)

    def do_PUT(self):
        if self.path.startswith('/api/'):
            return self.proxy()
        self.send_error(405)

    def do_PATCH(self):
        if self._handle_virt_intel():
            return
        if self._handle_tutorials():
            return
        if self.path.startswith('/api/'):
            return self.proxy()
        self.send_error(405)

    def do_DELETE(self):
        if self.path.startswith('/api/'):
            return self.proxy()
        self.send_error(405)

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True

if __name__ == '__main__':
    if not os.path.isdir(ROOT):
        print('找不到 dist：' + ROOT); sys.exit(1)
    from bookoff_demo import seed_bookoff
    seed_bookoff(BOOKOFF_DB)
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        print('销售工作台 Stitch H5：http://localhost:%d/' % PORT)
        httpd.serve_forever()
