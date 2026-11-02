// Notifikasi: tersimpan di aplikasi (lonceng), push ke HP, dan email.
// Email aktif bila SMTP_HOST diisi (SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL).
const webpush = require('web-push');
const nodemailer = require('nodemailer');

module.exports = function (db) {
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  db.exec(`
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER, ts TEXT, title TEXT, body TEXT, url TEXT, read INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, user_id INTEGER, sub TEXT, created_at TEXT);
  `);
  if (!all('PRAGMA table_info(users)').some(c => c.name === 'email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT; ALTER TABLE users ADD COLUMN email_on INTEGER DEFAULT 1;');
  }

  const setting = (k, v) => v === undefined ? (get('SELECT value FROM settings WHERE key=?', k) || {}).value
    : run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', k, String(v));

  // kunci VAPID dibuat sekali dan disimpan di database
  let keys = setting('vapid') && JSON.parse(setting('vapid'));
  if (!keys) { keys = webpush.generateVAPIDKeys(); setting('vapid', JSON.stringify(keys)); }
  webpush.setVapidDetails('mailto:' + (process.env.SMTP_FROM || 'admin@ornovaintegrasolusi.com').replace(/.*</, '').replace(/>.*/, ''), keys.publicKey, keys.privateKey);

  const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  }) : null;
  const appUrl = (process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/$/, '');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function deliver(uid, n) {
    for (const s of all('SELECT * FROM push_subs WHERE user_id=?', uid)) {
      try { await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify(n), { TTL: 86400 }); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subs WHERE endpoint=?', s.endpoint); else console.error('push', e.statusCode || e.message); }
    }
    const u = get('SELECT name,email,email_on FROM users WHERE id=?', uid);
    if (mailer && u && u.email && u.email_on) {
      try {
        await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: u.email, subject: n.title,
          text: `${n.body}\n\n${appUrl}/${n.url || ''}`,
          html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2430"><p>Halo ${esc(u.name)},</p><p style="white-space:pre-line">${esc(n.body)}</p>
            <p><a href="${appUrl}/${n.url || ''}" style="background:#1f5fbf;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Buka aplikasi</a></p>
            <p style="color:#6b7686;font-size:12px">Kentang Brokoli · email otomatis</p></div>` });
      } catch (e) { console.error('email', e.message); }
    }
  }

  // kirim ke daftar user id; tersimpan dulu, pengiriman push/email di latar
  function notify(uids, n) {
    const ids = [...new Set(uids.filter(Boolean))];
    for (const uid of ids) {
      run('INSERT INTO notifications(user_id,ts,title,body,url) VALUES(?,?,?,?,?)', uid, new Date().toISOString(), n.title, n.body, n.url || '');
      deliver(uid, n);
    }
  }
  const toRole = (roles, n) => notify(all(`SELECT id FROM users WHERE role IN (${roles.map(() => '?').join(',')})`, ...roles).map(u => u.id), n);

  return {
    notify, toRole, setting,
    publicKey: keys.publicKey,
    emailReady: !!mailer,
    subscribe: (uid, sub) => run('INSERT OR REPLACE INTO push_subs(endpoint,user_id,sub,created_at) VALUES(?,?,?,?)', sub.endpoint, uid, JSON.stringify(sub), new Date().toISOString()),
    unsubscribe: endpoint => run('DELETE FROM push_subs WHERE endpoint=?', endpoint),
    list: uid => ({ items: all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', uid),
      unread: get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', uid).n,
      pushCount: get('SELECT COUNT(*) n FROM push_subs WHERE user_id=?', uid).n }),
    markRead: uid => run('UPDATE notifications SET read=1 WHERE user_id=?', uid),
  };
};
