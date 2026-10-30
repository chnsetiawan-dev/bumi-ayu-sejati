// Aplikasi Penjualan Kentang Brokoli — prototipe lokal (Node 22+, tanpa dependency)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.db');
const fresh = !fs.existsSync(DB_FILE);
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys=ON');

// ---------- skema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, username TEXT UNIQUE, pin TEXT, role TEXT);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, code TEXT, name TEXT, unit TEXT, priority INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, name TEXT, phone TEXT, address TEXT, sales_id INTEGER, channel TEXT,
  price_group TEXT, tempo_days INTEGER DEFAULT 0, approved INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS prices(date TEXT, product_id INTEGER, price_group TEXT, price REAL, PRIMARY KEY(date,product_id,price_group));
CREATE TABLE IF NOT EXISTS stock(date TEXT, product_id INTEGER, qty REAL, PRIMARY KEY(date,product_id));
CREATE TABLE IF NOT EXISTS quotas(month TEXT, sales_id INTEGER, product_id INTEGER, qty REAL, PRIMARY KEY(month,sales_id,product_id));
CREATE TABLE IF NOT EXISTS targets(month TEXT, sales_id INTEGER, omzet REAL, new_customers INTEGER, bonus_base REAL, PRIMARY KEY(month,sales_id));
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, no TEXT, date TEXT, customer_id INTEGER, sales_id INTEGER, pay_type TEXT,
  ship_date TEXT, due_date TEXT, status TEXT, approval_reason TEXT, total REAL, created_by INTEGER, shipped_at TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, qty REAL, price REAL, discount REAL);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, order_id INTEGER, amount REAL, date TEXT, method TEXT, created_by INTEGER);
CREATE TABLE IF NOT EXISTS returns(id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, qty REAL, amount REAL, reason TEXT,
  status TEXT, date TEXT, created_by INTEGER);
CREATE TABLE IF NOT EXISTS contacts(id INTEGER PRIMARY KEY, sales_id INTEGER, customer_id INTEGER, date TEXT, offer TEXT, result TEXT);
CREATE TABLE IF NOT EXISTS violations(id INTEGER PRIMARY KEY, sales_id INTEGER, date TEXT, type TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts TEXT, user_id INTEGER, action TEXT, detail TEXT);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const month = (d = today()) => d.slice(0, 7);
const audit = (uid, action, detail) => run('INSERT INTO audit(ts,user_id,action,detail) VALUES(?,?,?,?)', new Date().toISOString(), uid, action, JSON.stringify(detail));

// batas potongan per satuan (aturan no. 2)
const MAX_DISC = { butir: 100, kg: 500 };

if (fresh) require('./seed')(db, { today, addDays });

// ---------- penamaan pelanggan baku: "Nama Inti, Badan Usaha" (mis. "Superindo, PT", "Amir, Toko") ----------
const ENTITIES = ['PT', 'CV', 'UD', 'Toko', 'Warung', 'Agen', 'Kios', 'Resto', 'Koperasi', 'Perorangan'];
const titleCase = s => s.toLowerCase().replace(/(^|[\s\-\/(])([a-z])/g, (m, a, b) => a + b.toUpperCase());
// kunci pembanding: tanpa badan usaha, tanda baca, spasi, huruf besar/kecil
const nameKey = s => s.toLowerCase().replace(new RegExp(`\\b(${ENTITIES.join('|')}|tbk|bu|pak|ibu)\\b`, 'gi'), '').replace(/[^a-z0-9]/g, '');
function splitName(raw) {
  let s = String(raw || '').replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim(), ent = '';
  const re = new RegExp(`^(${ENTITIES.join('|')})\\s+|\\s+(${ENTITIES.join('|')})$`, 'i');
  const m = s.match(re);
  if (m) { ent = ENTITIES.find(e => e.toLowerCase() === (m[1] || m[2]).toLowerCase()); s = s.replace(re, '').trim(); }
  return { core: s, entity: ent };
}
function formatName(core, entity) {
  const c = titleCase(String(core || '').replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim());
  if (!c) throw new Error('Nama pelanggan wajib diisi');
  return entity && entity !== 'Perorangan' ? `${c}, ${entity}` : c;
}
// tambah kolom & rapikan nama lama sekali jalan
if (!all('PRAGMA table_info(customers)').some(c => c.name === 'name_key')) {
  db.exec('ALTER TABLE customers ADD COLUMN entity TEXT; ALTER TABLE customers ADD COLUMN name_key TEXT;');
  for (const c of all('SELECT id,name FROM customers')) {
    const { core, entity } = splitName(c.name);
    run('UPDATE customers SET name=?, entity=?, name_key=? WHERE id=?', formatName(core, entity), entity, nameKey(core), c.id);
  }
}
function similarCustomers(core, exceptId) {
  const k = nameKey(core);
  if (k.length < 3) return [];
  return all('SELECT c.id, c.name, c.address, u.name sales FROM customers c LEFT JOIN users u ON u.id=c.sales_id WHERE c.id != ?', exceptId || 0)
    .filter(c => { const ck = nameKey(splitName(c.name).core); return ck === k || ck.includes(k) || (ck.length >= 3 && k.includes(ck)); });
}

// ---------- logika bisnis ----------
function priceFor(productId, group, date = today()) {
  const r = get('SELECT price FROM prices WHERE product_id=? AND price_group=? AND date<=? ORDER BY date DESC LIMIT 1', productId, group, date);
  return r ? r.price : 0;
}

// sisa tagihan per nota (total − bayar − retur disetujui)
const OUTSTANDING_SQL = `
SELECT o.*, c.name customer, c.price_group, u.name sales,
  o.total - IFNULL((SELECT SUM(amount) FROM payments p WHERE p.order_id=o.id),0)
          - IFNULL((SELECT SUM(amount) FROM returns r WHERE r.order_id=o.id AND r.status='approved'),0) AS sisa
FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN users u ON u.id=o.sales_id
WHERE o.status IN ('approved','shipped')`;

function outstanding(where = '', ...p) {
  const t = today();
  return all(`SELECT * FROM (${OUTSTANDING_SQL}) WHERE sisa > 0.5 ${where} ORDER BY due_date`, ...p).map(r => {
    const late = r.due_date ? daysBetween(r.due_date, t) : 0;
    return { ...r, late, bucket: late <= 0 ? 'belum' : late <= 7 ? '1-7' : '>7' };
  });
}

function customerMaxLate(cid) {
  return outstanding('AND customer_id=?', cid).reduce((m, r) => Math.max(m, r.late), 0);
}

function isNewCustomer(cid) {
  // baru = tidak ada order dalam 6 bulan terakhir
  return !get(`SELECT 1 FROM orders WHERE customer_id=? AND status!='rejected' AND date>=?`, cid, addDays(today(), -182));
}

function createOrder(user, b) {
  const c = get('SELECT * FROM customers WHERE id=?', b.customer_id);
  if (!c) throw new Error('Pelanggan tidak ditemukan');
  if (user.role === 'sales' && c.sales_id !== user.id) throw new Error('Bukan pelanggan Anda');
  const items = (b.items || []).filter(i => i.qty > 0);
  if (!items.length) throw new Error('Isi minimal satu produk');

  const reasons = [];
  let total = 0;
  const rows = items.map(i => {
    const p = get('SELECT * FROM products WHERE id=?', i.product_id);
    const price = priceFor(p.id, c.price_group);
    const disc = Number(i.discount || 0);
    if (MAX_DISC[p.unit] != null && disc > MAX_DISC[p.unit]) reasons.push(`Potongan ${p.code} Rp ${disc}/${p.unit} melebihi batas Rp ${MAX_DISC[p.unit]}`);
    total += (price - disc) * i.qty;
    return { product_id: p.id, qty: i.qty, price, discount: disc };
  });

  const pay = b.pay_type === 'tempo' ? 'tempo' : 'cash';
  if (pay === 'tempo' && isNewCustomer(c.id)) reasons.push('Pelanggan baru minta tempo (aturan: wajib cash)');
  const late = customerMaxLate(c.id);
  if (late > 7) reasons.push(`Pelanggan menunggak ${late} hari`);

  const ship = b.ship_date || today();
  const due = pay === 'tempo' ? addDays(ship, c.tempo_days || 14) : ship;
  const status = reasons.length && user.role !== 'owner' ? 'pending' : 'approved';
  const prefix = 'NT' + today().replace(/-/g, '').slice(2) + '-';
  let seq = get('SELECT COUNT(*) n FROM orders WHERE date=?', today()).n + 1, no;
  while (get('SELECT 1 FROM orders WHERE no=?', no = prefix + String(seq).padStart(3, '0'))) seq++;
  const r = run(`INSERT INTO orders(no,date,customer_id,sales_id,pay_type,ship_date,due_date,status,approval_reason,total,created_by,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, no, today(), c.id, c.sales_id, pay, ship, due, status, reasons.join('; '), total, user.id, b.note || '');
  const oid = Number(r.lastInsertRowid);
  for (const it of rows) run('INSERT INTO order_items(order_id,product_id,qty,price,discount) VALUES(?,?,?,?,?)', oid, it.product_id, it.qty, it.price, it.discount);
  audit(user.id, 'order.create', { no, total, status, reasons });
  return { id: oid, no, status, reasons, total };
}

function salesSummary(from, to, salesId) {
  const f = salesId ? 'AND o.sales_id=?' : '';
  const args = salesId ? [from, to, salesId] : [from, to];
  const gross = all(`SELECT o.sales_id, SUM(i.qty*(i.price-i.discount)) omzet FROM orders o JOIN order_items i ON i.order_id=o.id
    WHERE o.status IN ('approved','shipped') AND o.date BETWEEN ? AND ? ${f} GROUP BY o.sales_id`, ...args);
  const ret = all(`SELECT o.sales_id, SUM(r.amount) retur FROM returns r JOIN orders o ON o.id=r.order_id
    WHERE r.status='approved' AND r.date BETWEEN ? AND ? ${f} GROUP BY o.sales_id`, ...args);
  const m = {};
  gross.forEach(g => m[g.sales_id] = { omzet: g.omzet, retur: 0 });
  ret.forEach(r => { m[r.sales_id] = m[r.sales_id] || { omzet: 0, retur: 0 }; m[r.sales_id].retur = r.retur; });
  return m;
}

function kpi(mon = month()) {
  const from = mon + '-01', to = mon + '-31';
  const sales = all("SELECT id,name FROM users WHERE role='sales' ORDER BY name");
  const sum = salesSummary(from, to);
  return sales.map(s => {
    const t = get('SELECT * FROM targets WHERE month=? AND sales_id=?', mon, s.id) || { omzet: 0, new_customers: 0, bonus_base: 0 };
    const net = ((sum[s.id] || {}).omzet || 0) - ((sum[s.id] || {}).retur || 0);

    // kuota prioritas dalam rupiah (harga Jbr hari ini sebagai pembanding)
    const q = all(`SELECT q.product_id, q.qty, IFNULL((SELECT SUM(i.qty) FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE o.sales_id=? AND i.product_id=q.product_id AND o.status IN ('approved','shipped') AND o.date BETWEEN ? AND ?),0) sold
      FROM quotas q WHERE q.month=? AND q.sales_id=?`, s.id, from, to, mon, s.id);
    let qRp = 0, sRp = 0;
    q.forEach(x => { const p = priceFor(x.product_id, 'Jbr'); qRp += x.qty * p; sRp += Math.min(x.sold, x.qty) * p; });
    const prioPct = qRp ? sRp / qRp * 100 : 100;

    // pelanggan baru: order pertama bulan ini dan sudah order ≥ 2 kali
    const newCust = all(`SELECT customer_id, MIN(date) first, COUNT(*) n FROM orders WHERE sales_id=? AND status IN ('approved','shipped')
      GROUP BY customer_id HAVING first BETWEEN ? AND ?`, s.id, from, to);
    const newOk = newCust.filter(x => x.n >= 2).length;

    const viol = get('SELECT COUNT(*) n FROM violations WHERE sales_id=? AND date BETWEEN ? AND ?', s.id, from, to).n;
    const lateOver7 = outstanding("AND sales_id=? AND due_date < ?", s.id, addDays(today(), -7)).length;

    const checks = [
      { k: 'Omzet', ok: t.omzet > 0 && net >= t.omzet, v: `${fmt(net)} / ${fmt(t.omzet)}` },
      { k: 'Prioritas', ok: prioPct >= 90, v: prioPct.toFixed(0) + '% kuota' },
      { k: 'Pelanggan baru', ok: newOk >= t.new_customers, v: `${newOk} / ${t.new_customers} (${newCust.length} baru)` },
      { k: 'Disiplin', ok: viol <= 3, v: viol + ' pelanggaran' },
      { k: 'Piutang', ok: lateOver7 === 0, v: lateOver7 + ' nota lewat >7 hari' },
    ];
    const n = checks.filter(c => c.ok).length;
    const mult = n === 5 ? 1.5 : n === 4 ? 1 : n === 3 ? 0.5 : 0;
    return { sales_id: s.id, name: s.name, net, target: t.omzet, pct: t.omzet ? net / t.omzet * 100 : 0, checks, n, mult, bonus: mult * (t.bonus_base || 0) };
  });
}
const fmt = n => 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');

function dashboard(user) {
  const t = today(), mon = month();
  const sid = user.role === 'sales' ? user.id : null;
  const sf = sid ? 'AND o.sales_id=' + sid : '';
  const todayBySales = all(`SELECT u.name, COUNT(DISTINCT o.id) nota, SUM(i.qty*(i.price-i.discount)) rp FROM orders o JOIN order_items i ON i.order_id=o.id
    LEFT JOIN users u ON u.id=o.sales_id WHERE o.date=? AND o.status IN ('approved','shipped') ${sf} GROUP BY o.sales_id ORDER BY rp DESC`, t);
  const todayByProduct = all(`SELECT p.code, p.name, p.unit, SUM(i.qty) qty, SUM(i.qty*(i.price-i.discount)) rp FROM orders o JOIN order_items i ON i.order_id=o.id
    JOIN products p ON p.id=i.product_id WHERE o.date=? AND o.status IN ('approved','shipped') ${sf} GROUP BY p.id ORDER BY rp DESC`, t);
  const unshipped = get(`SELECT COUNT(*) n FROM orders o WHERE status='approved' ${sf}`).n;
  const pending = all(`SELECT o.id,o.no,o.total,o.approval_reason,c.name customer,u.name sales FROM orders o JOIN customers c ON c.id=o.customer_id
    LEFT JOIN users u ON u.id=o.sales_id WHERE o.status='pending' ${sf} ORDER BY o.id DESC`);
  const pendingCust = user.role === 'owner' ? all('SELECT c.*, u.name sales FROM customers c LEFT JOIN users u ON u.id=c.sales_id WHERE approved=0') : [];
  const out = outstanding(sid ? 'AND sales_id=?' : '', ...(sid ? [sid] : []));
  const aging = { belum: 0, '1-7': 0, '>7': 0 };
  out.forEach(r => aging[r.bucket] += r.sisa);
  const k = kpi(mon).filter(x => !sid || x.sales_id === sid);
  const sleeping = all(`SELECT c.id, c.name, u.name sales, MAX(o.date) last FROM customers c LEFT JOIN users u ON u.id=c.sales_id
    LEFT JOIN orders o ON o.customer_id=c.id AND o.status IN ('approved','shipped') WHERE c.approved=1 ${sid ? 'AND c.sales_id=' + sid : ''}
    GROUP BY c.id HAVING last IS NULL OR last < ? ORDER BY last`, addDays(t, -14));
  const stock = all(`SELECT p.id,p.code,p.name,p.unit,p.priority, IFNULL((SELECT qty FROM stock s WHERE s.product_id=p.id AND s.date=?),0) stock,
    IFNULL((SELECT SUM(i.qty) FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.product_id=p.id AND o.date=? AND o.status IN ('approved','shipped','pending')),0) sold_today,
    IFNULL((SELECT SUM(qty) FROM quotas q WHERE q.product_id=p.id AND q.month=?),0) quota,
    IFNULL((SELECT SUM(i.qty) FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.product_id=p.id AND o.date>=? AND o.status IN ('approved','shipped')),0) sold_month
    FROM products p WHERE active=1 ORDER BY priority DESC, code`, t, t, mon, mon + '-01');
  return { today: t, todayBySales, todayByProduct, unshipped, pending, pendingCust, aging, total: out.reduce((a, r) => a + r.sisa, 0),
    lateList: out.filter(r => r.bucket !== 'belum'), kpi: k, sleeping, stock };
}

// ---------- HTTP ----------
const sessions = new Map();
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const csv = rows => {
  if (!rows.length) return '';
  const h = Object.keys(rows[0]);
  const e = v => /[",;\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? '');
  return '﻿' + [h.join(';'), ...rows.map(r => h.map(k => e(r[k])).join(';'))].join('\r\n');
};

const routes = {
  'POST /api/login': (u, b) => {
    const user = get('SELECT id,name,role,username FROM users WHERE username=? AND pin=?', b.username, b.pin);
    if (!user) throw Object.assign(new Error('Username / password salah'), { code: 401 });
    const tok = crypto.randomBytes(16).toString('hex');
    sessions.set(tok, user);
    return { token: tok, user };
  },
  'GET /api/users': () => all("SELECT id,name,username,role FROM users ORDER BY instr('owner admin sales finance warehouse', role), name"),
  'GET /api/me': u => u,
  'GET /api/dashboard': u => dashboard(u),
  'GET /api/kpi': (u, b, q) => kpi(q.month || month()).filter(x => u.role !== 'sales' || x.sales_id === u.id),

  'GET /api/products': () => all('SELECT * FROM products ORDER BY priority DESC, code'),
  'POST /api/products': (u, b) => { need(u, 'admin', 'owner');
    if (b.id) run('UPDATE products SET code=?,name=?,unit=?,priority=?,active=? WHERE id=?', b.code, b.name, b.unit, b.priority ? 1 : 0, b.active ?? 1, b.id);
    else run('INSERT INTO products(code,name,unit,priority) VALUES(?,?,?,?)', b.code, b.name, b.unit, b.priority ? 1 : 0);
    audit(u.id, 'product.save', b); return { ok: 1 }; },

  'GET /api/customers': u => all(`SELECT c.*, u.name sales FROM customers c LEFT JOIN users u ON u.id=c.sales_id
    ${u.role === 'sales' ? 'WHERE c.sales_id=' + u.id : ''} ORDER BY c.name`).map(c => ({ ...c, maxLate: customerMaxLate(c.id),
    piutang: outstanding('AND customer_id=?', c.id).reduce((a, r) => a + r.sisa, 0), isNew: isNewCustomer(c.id) })),
  'POST /api/customers': (u, b) => { need(u, 'admin', 'owner', 'sales');
    const sales = u.role === 'sales' ? u.id : (b.sales_id || null);
    // tempo hanya bisa diatur pemilik; pelanggan baru default cash
    const tempo = u.role === 'owner' ? Number(b.tempo_days || 0) : (b.id ? get('SELECT tempo_days FROM customers WHERE id=?', b.id).tempo_days : 0);
    const approved = u.role === 'owner' ? 1 : (b.id ? get('SELECT approved FROM customers WHERE id=?', b.id).approved : 0);
    const entity = ENTITIES.includes(b.entity) ? b.entity : '';
    const name = formatName(b.core, entity), key = nameKey(b.core);
    // nama sama persis (tanpa badan usaha) ditolak; sales tidak bisa memaksa, admin/pemilik bisa
    const dup = similarCustomers(b.core, b.id).filter(c => nameKey(splitName(c.name).core) === key);
    if (dup.length && !(b.force && u.role !== 'sales'))
      throw Object.assign(new Error(`Pelanggan "${dup[0].name}" sudah ada (sales: ${dup[0].sales || 'Pemilik'}). Pakai yang sudah ada.`), { code: 409 });
    if (b.id) run('UPDATE customers SET name=?,entity=?,name_key=?,phone=?,address=?,sales_id=?,channel=?,price_group=?,tempo_days=?,approved=? WHERE id=?',
      name, entity, key, b.phone || "", b.address || "", sales, b.channel, b.price_group, tempo, approved, b.id);
    else run('INSERT INTO customers(name,entity,name_key,phone,address,sales_id,channel,price_group,tempo_days,approved,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      name, entity, key, b.phone || "", b.address || "", sales, b.channel, b.price_group, tempo, approved, today());
    audit(u.id, 'customer.save', { ...b, name }); return { ok: 1, name, needsApproval: !approved }; },
  'GET /api/customers/similar': (u, b, q) => ({ preview: q.core ? formatName(q.core, q.entity) : '', similar: similarCustomers(q.core || '', +q.id).slice(0, 8) }),
  'POST /api/customers/approve': (u, b) => { need(u, 'owner'); run('UPDATE customers SET approved=1, tempo_days=? WHERE id=?', Number(b.tempo_days || 0), b.id); audit(u.id, 'customer.approve', b); return { ok: 1 }; },

  'GET /api/prices': (u, b, q) => { const d = q.date || today();
    return all('SELECT p.id product_id,p.code,p.name,p.unit,p.priority FROM products p WHERE active=1 ORDER BY priority DESC,code').map(p => ({ ...p,
      Jbr: priceFor(p.product_id, 'Jbr', d), 'Sby/LP': priceFor(p.product_id, 'Sby/LP', d), Blitar: priceFor(p.product_id, 'Blitar', d),
      stock: (get('SELECT qty FROM stock WHERE product_id=? AND date=?', p.product_id, d) || {}).qty ?? null })); },
  'POST /api/prices': (u, b) => { need(u, 'admin', 'owner', 'warehouse'); const d = b.date || today();
    for (const r of b.rows) {
      if (u.role !== 'warehouse') for (const g of ['Jbr', 'Sby/LP', 'Blitar']) if (r[g] != null && r[g] !== '')
        run('INSERT OR REPLACE INTO prices(date,product_id,price_group,price) VALUES(?,?,?,?)', d, r.product_id, g, Number(r[g]));
      if (r.stock != null && r.stock !== '') run('INSERT OR REPLACE INTO stock(date,product_id,qty) VALUES(?,?,?)', d, r.product_id, Number(r.stock));
      if (u.role !== 'warehouse' && r.priority != null) run('UPDATE products SET priority=? WHERE id=?', r.priority ? 1 : 0, r.product_id);
    }
    audit(u.id, 'prices.save', { date: d, n: b.rows.length }); return { ok: 1 }; },

  'GET /api/orders': (u, b, q) => {
    const w = []; const p = [];
    if (u.role === 'sales') { w.push('o.sales_id=?'); p.push(u.id); }
    if (q.status) { w.push('o.status=?'); p.push(q.status); }
    if (q.from) { w.push('o.date>=?'); p.push(q.from); }
    return all(`SELECT o.*, c.name customer, u.name sales FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN users u ON u.id=o.sales_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY o.id DESC LIMIT 300`, ...p); },
  'GET /api/order': (u, b, q) => { const o = get(`SELECT o.*, c.name customer, c.address, c.phone, u.name sales FROM orders o JOIN customers c ON c.id=o.customer_id
      LEFT JOIN users u ON u.id=o.sales_id WHERE o.id=?`, q.id);
    if (u.role === 'sales' && o.sales_id !== u.id) throw new Error('Tidak boleh');
    o.items = all('SELECT i.*, p.code, p.name, p.unit FROM order_items i JOIN products p ON p.id=i.product_id WHERE order_id=?', o.id);
    o.payments = all('SELECT * FROM payments WHERE order_id=?', o.id);
    o.returns = all('SELECT r.*, p.code FROM returns r JOIN products p ON p.id=r.product_id WHERE order_id=?', o.id);
    o.history = all("SELECT a.ts, a.action, a.detail, u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.detail LIKE ? ORDER BY a.id", `%"${o.no}"%`);
    return o; },
  'POST /api/orders': (u, b) => { need(u, 'sales', 'admin', 'owner'); return createOrder(u, b); },
  'POST /api/orders/approve': (u, b) => { need(u, 'owner'); const o = get('SELECT no FROM orders WHERE id=?', b.id);
    run("UPDATE orders SET status=? WHERE id=? AND status='pending'", b.ok ? 'approved' : 'rejected', b.id);
    audit(u.id, b.ok ? 'order.approve' : 'order.reject', { no: o.no }); return { ok: 1 }; },
  'POST /api/orders/ship': (u, b) => { need(u, 'warehouse', 'admin', 'owner'); const o = get('SELECT no FROM orders WHERE id=?', b.id);
    run("UPDATE orders SET status='shipped', shipped_at=? WHERE id=? AND status='approved'", new Date().toISOString(), b.id);
    audit(u.id, 'order.ship', { no: o.no }); return { ok: 1 }; },

  'GET /api/receivables': u => outstanding(u.role === 'sales' ? 'AND sales_id=?' : '', ...(u.role === 'sales' ? [u.id] : [])),
  'POST /api/payments': (u, b) => { need(u, 'finance', 'owner', 'admin'); const o = get('SELECT no FROM orders WHERE id=?', b.order_id);
    run('INSERT INTO payments(order_id,amount,date,method,created_by) VALUES(?,?,?,?,?)', b.order_id, Number(b.amount), b.date || today(), b.method, u.id);
    audit(u.id, 'payment.add', { no: o.no, amount: b.amount, method: b.method }); return { ok: 1 }; },

  'GET /api/returns': u => all(`SELECT r.*, o.no, c.name customer, p.code, us.name sales FROM returns r JOIN orders o ON o.id=r.order_id
    JOIN customers c ON c.id=o.customer_id JOIN products p ON p.id=r.product_id LEFT JOIN users us ON us.id=o.sales_id
    ${u.role === 'sales' ? 'WHERE o.sales_id=' + u.id : ''} ORDER BY r.id DESC`),
  'POST /api/returns': (u, b) => { need(u, 'sales', 'admin', 'owner');
    const it = get('SELECT i.*, o.no FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.order_id=? AND i.product_id=?', b.order_id, b.product_id);
    if (!it) throw new Error('Produk tidak ada di nota itu');
    const amount = (it.price - it.discount) * Number(b.qty);
    run('INSERT INTO returns(order_id,product_id,qty,amount,reason,status,date,created_by) VALUES(?,?,?,?,?,?,?,?)',
      b.order_id, b.product_id, Number(b.qty), amount, b.reason, u.role === 'sales' ? 'pending' : 'approved', today(), u.id);
    audit(u.id, 'return.add', { no: it.no, qty: b.qty, amount }); return { ok: 1 }; },
  'POST /api/returns/approve': (u, b) => { need(u, 'admin', 'owner'); run("UPDATE returns SET status=? WHERE id=?", b.ok ? 'approved' : 'rejected', b.id);
    audit(u.id, 'return.' + (b.ok ? 'approve' : 'reject'), { id: b.id }); return { ok: 1 }; },

  'GET /api/contacts': u => all(`SELECT k.*, c.name customer, us.name sales FROM contacts k JOIN customers c ON c.id=k.customer_id
    LEFT JOIN users us ON us.id=k.sales_id ${u.role === 'sales' ? 'WHERE k.sales_id=' + u.id : ''} ORDER BY k.id DESC LIMIT 200`),
  'POST /api/contacts': (u, b) => { run('INSERT INTO contacts(sales_id,customer_id,date,offer,result) VALUES(?,?,?,?,?)', u.id, b.customer_id, today(), b.offer, b.result); return { ok: 1 }; },

  'GET /api/violations': () => all('SELECT v.*, u.name sales FROM violations v JOIN users u ON u.id=v.sales_id ORDER BY date DESC LIMIT 200'),
  'POST /api/violations': (u, b) => { need(u, 'admin', 'owner'); run('INSERT INTO violations(sales_id,date,type) VALUES(?,?,?)', b.sales_id, b.date || today(), b.type); audit(u.id, 'violation.add', b); return { ok: 1 }; },

  'GET /api/targets': (u, b, q) => { const m = q.month || month();
    return all("SELECT id sales_id, name FROM users WHERE role='sales' ORDER BY name").map(s => ({ ...s,
      ...(get('SELECT omzet,new_customers,bonus_base FROM targets WHERE month=? AND sales_id=?', m, s.sales_id) || {}),
      quotas: all('SELECT product_id, qty FROM quotas WHERE month=? AND sales_id=?', m, s.sales_id) })); },
  'POST /api/targets': (u, b) => { need(u, 'owner', 'admin'); const m = b.month || month();
    for (const r of b.rows) {
      if (u.role === 'owner') run('INSERT OR REPLACE INTO targets(month,sales_id,omzet,new_customers,bonus_base) VALUES(?,?,?,?,?)', m, r.sales_id, Number(r.omzet || 0), Number(r.new_customers || 0), Number(r.bonus_base || 0));
      for (const q of r.quotas || []) run('INSERT OR REPLACE INTO quotas(month,sales_id,product_id,qty) VALUES(?,?,?,?)', m, r.sales_id, q.product_id, Number(q.qty || 0));
    }
    audit(u.id, 'targets.save', { month: m }); return { ok: 1 }; },

  'GET /api/recap': (u, b, q) => { const d = q.date || today();
    const s = salesSummary(d, d); const users = all("SELECT id,name FROM users");
    const pay = get('SELECT IFNULL(SUM(amount),0) n FROM payments WHERE date=?', d).n;
    const out = outstanding(); const late = out.filter(r => r.bucket === '>7');
    const lines = [`*Rekap ${d}*`, ...Object.entries(s).map(([id, v]) => `• ${(users.find(x => x.id == id) || { name: 'Akun pemilik' }).name}: ${fmt(v.omzet - v.retur)}`),
      `Total penjualan: ${fmt(Object.values(s).reduce((a, v) => a + v.omzet - v.retur, 0))}`, `Pembayaran masuk: ${fmt(pay)}`,
      `Piutang: ${fmt(out.reduce((a, r) => a + r.sisa, 0))} (lewat >7 hari: ${fmt(late.reduce((a, r) => a + r.sisa, 0))}, ${late.length} nota)`];
    return { text: lines.join('\n') }; },
  'GET /api/audit': u => { need(u, 'owner', 'admin'); return all('SELECT a.*, u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200'); },
};

function need(u, ...roles) { if (!roles.includes(u.role)) throw Object.assign(new Error('Tidak punya akses'), { code: 403 }); }

const EXPORTS = {
  orders: () => all(`SELECT o.no, o.date tanggal, c.name pelanggan, u.name sales, o.pay_type bayar, o.ship_date kirim, o.due_date jatuh_tempo, o.status, o.total
    FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN users u ON u.id=o.sales_id ORDER BY o.id`),
  piutang: () => outstanding().map(r => ({ no: r.no, pelanggan: r.customer, sales: r.sales, jatuh_tempo: r.due_date, telat_hari: r.late, sisa: Math.round(r.sisa) })),
  pelanggan: () => all('SELECT c.name, c.phone, c.address, u.name sales, c.channel, c.price_group, c.tempo_days FROM customers c LEFT JOIN users u ON u.id=c.sales_id'),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/export/')) {
      const f = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^[\\/]+/, ''));
      if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
      const ext = path.extname(f);
      return send(res, 200, fs.readFileSync(f), { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream');
    }
    const tok = (req.headers.authorization || '').replace('Bearer ', '') || url.searchParams.get('t');
    const user = sessions.get(tok);
    if (url.pathname.startsWith('/export/')) {
      if (!user || user.role === 'sales') return send(res, 403, 'forbidden', 'text/plain');
      const k = url.pathname.split('/')[2];
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${k}-${today()}.csv"` });
      return res.end(csv(EXPORTS[k]()));
    }
    const key = req.method + ' ' + url.pathname;
    const h = routes[key];
    if (!h) return send(res, 404, { error: 'not found' });
    if (key !== 'POST /api/login' && key !== 'GET /api/users' && !user) return send(res, 401, { error: 'Silakan login' });
    let body = {};
    if (req.method === 'POST') { let s = ''; for await (const c of req) s += c; body = s ? JSON.parse(s) : {}; }
    send(res, 200, h(user, body, Object.fromEntries(url.searchParams)));
  } catch (e) { send(res, typeof e.code === "number" ? e.code : 400, { error: e.message }); }
}).listen(PORT, () => console.log(`Kentang Brokoli jalan di http://localhost:${PORT}`));
