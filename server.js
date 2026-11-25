'use strict';
// Máy chủ không cần thư viện ngoài: chỉ dùng Node.js 22.13+ (có sẵn node:sqlite).
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 2048) * 1048576;
const SECURE = process.env.COOKIE_SECURE === '1';          // bật khi chạy sau HTTPS
const TRUST_PROXY = process.env.TRUST_PROXY === '1';        // bật khi đứng sau nginx/caddy
const SESSION_MS = 7 * 24 * 3600 * 1000;
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'app.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', title TEXT DEFAULT '', phone TEXT DEFAULT '', photo TEXT DEFAULT '', created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plan(day TEXT PRIMARY KEY, entries TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, project TEXT, name TEXT, size INTEGER, user_id TEXT, uploader TEXT, at INTEGER);`);

// ---------- tiện ích ----------
const rid = (n = 9) => crypto.randomBytes(n).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, stored) => { const [s, k] = stored.split(':'); const h = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(h, Buffer.from(k, 'hex')); };
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (m, c = 400) => new HttpError(c, m);
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
const q = (sql, ...a) => db.prepare(sql).all(...a);
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

async function readJson(req, limit = 700000) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > limit) throw bad('Dữ liệu gửi lên quá lớn', 413); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw bad('Dữ liệu không hợp lệ'); }
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
function userOf(req) {
  const t = cookies(req).sid; if (!t) return null;
  const s = q1('SELECT * FROM sessions WHERE token=?', sha(t));
  if (!s || s.expires < Date.now()) return null;
  return q1('SELECT id,username,name,role FROM users WHERE id=?', s.user_id) || null;
}
const need = (u, role) => { if (!u) throw bad('Chưa đăng nhập', 401); if (role && u.role !== role) throw bad('Bạn không có quyền thực hiện thao tác này', 403); };

// giới hạn thử mật khẩu sai: 10 lần / 10 phút / địa chỉ IP
const tries = new Map();
const ipOf = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
function throttle(ip, ok) {
  const now = Date.now(); let t = tries.get(ip);
  if (!t || now - t.t > 600000) t = { n: 0, t: now };
  if (ok) { tries.delete(ip); return; }
  if (t.n >= 10) throw bad('Thử sai quá nhiều lần, hãy đợi vài phút', 429);
  t.n++; tries.set(ip, t);
}

// ---------- làm sạch dữ liệu ----------
const THEMES = ['auto', 'light', 'dark'];
function cleanConfig(c) {
  const arr = (a, n, f) => (Array.isArray(a) ? a.slice(0, n).map(f) : []);
  const obj = o => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).slice(0, 30).map(([k, v]) => [str(k, 30), str(v, 100)]));
  const u = c.ui || {};
  return {
    brand: str(c.brand, 80) || 'Studio sản xuất',
    tabs: arr(c.tabs, 20, t => ({ id: str(t.id, 20), label: str(t.label, 40) || 'Tab', on: t.on ? 1 : 0, ...(t.admin ? { admin: 1 } : {}) })),
    titles: obj(c.titles),
    widgets: arr(c.widgets, 20, w => ({ id: str(w.id, 20), label: str(w.label, 60), on: w.on ? 1 : 0 })),
    ui: { size: Math.min(20, Math.max(12, +u.size || 15)), radius: Math.min(24, Math.max(0, +u.radius || 0)), theme: THEMES.includes(u.theme) ? u.theme : 'auto' },
    projects: arr(c.projects, 100, p => str(p, 120)).filter(Boolean)
  };
}
function cleanEntries(a) {
  if (!Array.isArray(a) || a.length > 200) throw bad('Dữ liệu lịch không hợp lệ');
  return a.map(e => ({ id: str(e.id, 20), project: str(e.project, 120), place: str(e.place, 160), t: ['F', 'S', 'C', 'T'].includes(e.t) ? e.t : 'F',
    staff: Array.isArray(e.staff) ? e.staff.slice(0, 200).map(x => str(x, 40)) : [], note: str(e.note, 300) }));
}
const cleanPhoto = p => { p = String(p || ''); if (p && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p)) throw bad('Ảnh không hợp lệ'); if (p.length > 300000) throw bad('Ảnh quá lớn'); return p; };
const cleanName = n => path.basename(String(n || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '').slice(0, 200) || 'file';
const admins = () => q1("SELECT COUNT(*) c FROM users WHERE role='admin'").c;

// ---------- API ----------
async function api(req, res, url) {
  const m = req.method, p = url.pathname, u = userOf(req);
  if (m !== 'GET' && req.headers['x-requested-with'] !== 'app') throw bad('Yêu cầu không hợp lệ', 403);
  let r;

  if (p === '/api/login' && m === 'POST') {
    const ip = ipOf(req), b = await readJson(req, 5000);
    const row = q1('SELECT * FROM users WHERE username=?', str(b.username, 60).toLowerCase());
    if (!row || !checkPw(String(b.password || ''), row.pw)) { throttle(ip, false); throw bad('Sai tên đăng nhập hoặc mật khẩu', 401); }
    throttle(ip, true);
    const tok = rid(32);
    run('DELETE FROM sessions WHERE expires<?', Date.now());
    run('INSERT INTO sessions VALUES(?,?,?)', sha(tok), row.id, Date.now() + SESSION_MS);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${SECURE ? '; Secure' : ''}` });
  }
  if (p === '/api/logout' && m === 'POST') {
    const t = cookies(req).sid; if (t) run('DELETE FROM sessions WHERE token=?', sha(t));
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }
  need(u);

  if (p === '/api/state' && m === 'GET') {
    const cfg = q1("SELECT v FROM kv WHERE k='config'");
    const staff = q("SELECT id,username,name,title,phone,photo FROM users WHERE role='staff' ORDER BY name").map(s => (u.role === 'admin' ? s : { ...s, username: undefined }));
    const plan = Object.fromEntries(q('SELECT day,entries FROM plan').map(x => [x.day, JSON.parse(x.entries)]));
    const files = q('SELECT id,project,name,size,user_id uid,uploader "by",at FROM files ORDER BY at');
    return send(res, 200, { me: u, config: cfg ? JSON.parse(cfg.v) : null, staff, plan, files });
  }
  if (p === '/api/config' && m === 'PUT') {
    need(u, 'admin'); const c = cleanConfig(await readJson(req));
    run("INSERT INTO kv VALUES('config',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(c));
    return send(res, 200, { ok: true });
  }
  if ((r = p.match(/^\/api\/plan\/(\d{4}-\d{2}-\d{2})$/)) && m === 'PUT') {
    need(u, 'admin'); const e = cleanEntries((await readJson(req)).entries);
    run('INSERT INTO plan VALUES(?,?) ON CONFLICT(day) DO UPDATE SET entries=excluded.entries', r[1], JSON.stringify(e));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/users' && m === 'POST') {
    need(u, 'admin'); const b = await readJson(req);
    const un = str(b.username, 60).toLowerCase(), pw = String(b.password || '');
    if (!/^[a-z0-9._-]{3,}$/.test(un)) throw bad('Tên đăng nhập gồm chữ không dấu, số, . _ - và tối thiểu 3 ký tự');
    if (pw.length < 8) throw bad('Mật khẩu tối thiểu 8 ký tự');
    if (!str(b.name, 80).trim()) throw bad('Cần nhập họ tên');
    if (q1('SELECT 1 FROM users WHERE username=?', un)) throw bad('Tên đăng nhập đã tồn tại', 409);
    const id = rid(5);
    run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)', id, un, hashPw(pw), str(b.name, 80).trim(), b.role === 'admin' ? 'admin' : 'staff', str(b.title, 80), str(b.phone, 30), cleanPhoto(b.photo), Date.now());
    return send(res, 200, { id });
  }
  if ((r = p.match(/^\/api\/users\/([a-f0-9]+)$/))) {
    need(u, 'admin'); const row = q1('SELECT * FROM users WHERE id=?', r[1]); if (!row) throw bad('Không tìm thấy tài khoản', 404);
    if (m === 'PUT') {
      const b = await readJson(req);
      if (b.password !== undefined) { if (String(b.password).length < 8) throw bad('Mật khẩu tối thiểu 8 ký tự'); run('UPDATE users SET pw=? WHERE id=?', hashPw(String(b.password)), row.id); run('DELETE FROM sessions WHERE user_id=?', row.id); }
      if (b.name !== undefined) run('UPDATE users SET name=?,title=?,phone=?,photo=? WHERE id=?', str(b.name, 80).trim() || row.name, str(b.title, 80), str(b.phone, 30), cleanPhoto(b.photo), row.id);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      if (row.id === u.id) throw bad('Không thể xóa tài khoản đang đăng nhập');
      if (row.role === 'admin' && admins() <= 1) throw bad('Phải còn ít nhất một admin');
      run('DELETE FROM sessions WHERE user_id=?', row.id); run('DELETE FROM users WHERE id=?', row.id);
      return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/me/password' && m === 'PUT') {
    const b = await readJson(req, 5000), row = q1('SELECT * FROM users WHERE id=?', u.id);
    if (!checkPw(String(b.old || ''), row.pw)) throw bad('Mật khẩu hiện tại không đúng', 403);
    if (String(b.new || '').length < 8) throw bad('Mật khẩu mới tối thiểu 8 ký tự');
    run('UPDATE users SET pw=? WHERE id=?', hashPw(String(b.new)), u.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/files' && m === 'PUT') {   // upload: thân yêu cầu là nội dung file, ghi thẳng ra đĩa
    const project = str(url.searchParams.get('project'), 120), name = cleanName(url.searchParams.get('name'));
    const cfg = q1("SELECT v FROM kv WHERE k='config'");
    if (!cfg || !JSON.parse(cfg.v).projects.includes(project)) throw bad('Dự án không tồn tại');
    const len = +req.headers['content-length'];
    if (!len) throw bad('Thiếu dung lượng file', 411);
    if (len > MAX_UPLOAD) throw bad(`File vượt giới hạn ${MAX_UPLOAD / 1048576} MB`, 413);
    const id = rid(8), file = path.join(DATA, 'uploads', id); let n = 0;
    const out = fs.createWriteStream(file);
    try {
      await new Promise((ok, fail) => {
        req.on('data', c => { n += c.length; if (n > MAX_UPLOAD) { req.destroy(); fail(bad('File vượt giới hạn', 413)); } });
        req.on('error', fail); out.on('error', fail); out.on('finish', ok); req.pipe(out);
      });
    } catch (e) { out.destroy(); fs.rmSync(file, { force: true }); throw e; }
    run('INSERT INTO files VALUES(?,?,?,?,?,?,?)', id, project, name, n, u.id, u.name, Date.now());
    return send(res, 200, { id });
  }
  if ((r = p.match(/^\/api\/files\/([a-f0-9]+)(\/download)?$/))) {
    const f = q1('SELECT * FROM files WHERE id=?', r[1]); if (!f) throw bad('Không tìm thấy file', 404);
    if (r[2] && m === 'GET') {
      const fp = path.join(DATA, 'uploads', f.id); if (!fs.existsSync(fp)) throw bad('File đã bị mất trên máy chủ', 404);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}` });
      return fs.createReadStream(fp).pipe(res);
    }
    if (m === 'PUT') { need(u, 'admin'); run('UPDATE files SET name=? WHERE id=?', cleanName((await readJson(req, 5000)).name), f.id); return send(res, 200, { ok: true }); }
    if (m === 'DELETE') { need(u, 'admin'); fs.rmSync(path.join(DATA, 'uploads', f.id), { force: true }); run('DELETE FROM files WHERE id=?', f.id); return send(res, 200, { ok: true }); }
  }
  throw bad('Không tìm thấy', 404);
}

// ---------- khởi động ----------
if (!q1('SELECT 1 FROM users LIMIT 1')) {
  const un = (process.env.ADMIN_USER || 'admin').toLowerCase(), pw = process.env.ADMIN_PASS || rid(6);
  run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)', rid(5), un, hashPw(pw), 'Quản trị', 'admin', '', '', '', Date.now());
  console.log(`\nĐã tạo tài khoản admin đầu tiên\n  Tên đăng nhập: ${un}\n  Mật khẩu:      ${pw}\nHãy đăng nhập và đổi mật khẩu ngay.\n`);
}
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC_HEADERS }); return res.end(INDEX); }
    send(res, 404, { error: 'Không tìm thấy' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.code || 500, { error: e.code ? e.message : 'Lỗi máy chủ' });
    else res.destroy();
  }
}).listen(PORT, () => console.log(`Đang chạy tại http://localhost:${PORT}`));
