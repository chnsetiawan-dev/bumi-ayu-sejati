// Data contoh untuk uji coba — bukan data asli PT Bumi Ayu Sejati
module.exports = function seed(db, { today, addDays }) {
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const t = today();

  const users = [
    ['Pak Benny', 'benny', 'owner'], ['Mbak Amel (Admin)', 'admin', 'admin'],
    ['Rahmi', 'rahmi', 'sales'], ['Puji', 'puji', 'sales'], ['Amel', 'amel', 'sales'], ['Anggun', 'anggun', 'sales'],
    ['Keuangan', 'keuangan', 'finance'], ['Gudang', 'gudang', 'warehouse'],
  ];
  users.forEach(u => run('INSERT INTO users(name,username,pin,role) VALUES(?,?,?,?)', u[0], u[1], '1234', u[2]));
  const sales = [3, 4, 5, 6];

  // [kode, nama, satuan, prioritas, harga Jbr]
  const products = [
    ['AKM', 'AKM Print', 'butir', 1, 1850], ['AKM-KG', 'AKM Kiloan', 'kg', 0, 27500], ['AKK', 'AKK Free Range', 'butir', 1, 2400],
    ['BAU', 'BAU', 'butir', 0, 1700], ['BAK', 'BAK Kiloan', 'kg', 0, 26000], ['BSK', 'BSK', 'kg', 0, 25000],
    ['PYH', 'Puyuh', 'butir', 0, 450], ['PYH-M', 'Puyuh Matang', 'tray', 0, 18000], ['NGR', 'Telur Negeri', 'kg', 0, 28000],
    ['OMG', 'Omega', 'tray', 1, 42000], ['ORG', 'Organik', 'tray', 0, 55000], ['MNK', 'Manik', 'ikat', 0, 15000], ['BTN', 'Bitan', 'dos', 0, 320000],
  ];
  products.forEach(p => run('INSERT INTO products(code,name,unit,priority) VALUES(?,?,?,?)', p[0], p[1], p[2], p[3]));
  const groups = { Jbr: 1, 'Sby/LP': 1.04, Blitar: 0.97 };
  for (let d = -45; d <= 0; d++) {
    const date = addDays(t, d), drift = 1 + Math.sin(d / 6) * 0.03;
    products.forEach((p, i) => {
      for (const [g, f] of Object.entries(groups)) run('INSERT INTO prices VALUES(?,?,?,?)', date, i + 1, g, Math.round(p[4] * f * drift / 10) * 10);
    });
  }
  products.forEach((p, i) => run('INSERT INTO stock VALUES(?,?,?)', t, i + 1, p[2] === 'butir' ? 8000 + Math.round(rnd() * 12000) : 50 + Math.round(rnd() * 300)));

  const names = ['Toko Sumber Rejeki', 'UD Makmur Jaya', 'Toko Berkah', 'Warung Bu Sri', 'CV Telur Nusantara', 'Toko Sinar Abadi',
    'Superindo Bandung', 'Yogya Dept Store', 'Toko Maju Lancar', 'UD Sejahtera', 'Toko Ibu Ani', 'Pasar Baru Kios 12',
    'Toko Barokah', 'Agen Telur Surabaya', 'Toko Mekar', 'Resto Sederhana'];
  const channels = ['Jabar', 'Lokal', 'Luar pulau', 'Modern market', 'Eceran'];
  names.forEach((n, i) => {
    const ch = /Superindo|Yogya/.test(n) ? 'Modern market' : pick(channels);
    const pg = /Surabaya/.test(n) ? 'Sby/LP' : i % 5 === 3 ? 'Blitar' : 'Jbr';
    run('INSERT INTO customers(name,phone,address,sales_id,channel,price_group,tempo_days,approved,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      n, '08' + String(1200000000 + i * 7654321).slice(0, 10), 'Jl. Contoh No. ' + (i + 1), i === 15 ? null : sales[i % 4], ch, pg,
      ch === 'Modern market' ? 30 : 14, 1, addDays(t, -200));
  });

  const priceOf = (pid, g, d) => db.prepare('SELECT price FROM prices WHERE product_id=? AND price_group=? AND date=?').get(pid, g, d).price;
  const custs = db.prepare('SELECT * FROM customers').all();
  let n = 0;
  for (let d = -40; d <= 0; d++) {
    const date = addDays(t, d);
    const k = 3 + Math.floor(rnd() * 5);
    for (let j = 0; j < k; j++) {
      const c = pick(custs.slice(0, 14)); // 2 pelanggan terakhir sengaja "tidur"
      const items = [1 + Math.floor(rnd() * 13), 1 + Math.floor(rnd() * 13)].filter((v, i, a) => a.indexOf(v) === i);
      let total = 0;
      const rows = items.map(pid => {
        const unit = products[pid - 1][2];
        const qty = unit === 'butir' ? 300 + Math.round(rnd() * 15) * 100 : 5 + Math.round(rnd() * 40);
        const price = priceOf(pid, c.price_group, date); const disc = unit === 'butir' && rnd() < .3 ? 50 : 0;
        total += (price - disc) * qty; return [pid, qty, price, disc];
      });
      const tempo = rnd() < .7;
      const due = tempo ? addDays(date, c.tempo_days) : date;
      const status = d >= -1 && rnd() < .5 ? 'approved' : 'shipped';
      n++;
      const r = run(`INSERT INTO orders(no,date,customer_id,sales_id,pay_type,ship_date,due_date,status,approval_reason,total,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, 'NT' + date.replace(/-/g, '').slice(2) + '-' + String(j + 1).padStart(3, '0'), date, c.id, c.sales_id,
        tempo ? 'tempo' : 'cash', date, due, status, '', total, c.sales_id || 1);
      const oid = Number(r.lastInsertRowid);
      rows.forEach(x => run('INSERT INTO order_items(order_id,product_id,qty,price,discount) VALUES(?,?,?,?,?)', oid, ...x));
      // pembayaran: cash langsung lunas; tempo sebagian besar lunas, beberapa sengaja menunggak
      const lateDays = Math.round((new Date(t) - new Date(due)) / 864e5);
      if (!tempo) run('INSERT INTO payments(order_id,amount,date,method,created_by) VALUES(?,?,?,?,?)', oid, total, date, 'Tunai', 7);
      else if (lateDays > 0 && !(c.id % 6 === 2 && lateDays < 25) && rnd() < .85)
        run('INSERT INTO payments(order_id,amount,date,method,created_by) VALUES(?,?,?,?,?)', oid, total, addDays(due, -1), 'Transfer', 7);
    }
  }

  // satu order menunggu persetujuan & satu retur menunggu
  const c0 = custs[0];
  const r = run(`INSERT INTO orders(no,date,customer_id,sales_id,pay_type,ship_date,due_date,status,approval_reason,total,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, 'NT' + t.replace(/-/g, '').slice(2) + '-099', t, c0.id, c0.sales_id, 'tempo', addDays(t, 1), addDays(t, 15),
    'pending', 'Potongan AKM Rp 150/butir melebihi batas Rp 100', (priceOf(1, 'Jbr', t) - 150) * 600, c0.sales_id);
  run('INSERT INTO order_items(order_id,product_id,qty,price,discount) VALUES(?,?,?,?,?)', Number(r.lastInsertRowid), 1, 600, priceOf(1, 'Jbr', t), 150);
  run(`INSERT INTO returns(order_id,product_id,qty,amount,reason,status,date,created_by)
    SELECT o.id, i.product_id, 20, (i.price-i.discount)*20, 'Pecah saat kirim', 'pending', ?, o.sales_id FROM orders o JOIN order_items i ON i.order_id=o.id
    WHERE o.status='shipped' ORDER BY o.id DESC LIMIT 1`, t);

  const mon = t.slice(0, 7);
  sales.forEach((sid, i) => {
    run('INSERT INTO targets VALUES(?,?,?,?,?)', mon, sid, [180e6, 150e6, 160e6, 140e6][i], 2, 1500000);
    [1, 3, 10].forEach(pid => run('INSERT INTO quotas VALUES(?,?,?,?)', mon, sid, pid, products[pid - 1][2] === 'butir' ? 15000 : 60));
  });
  [[4, 3], [6, 5], [3, 1]].forEach(([sid, k]) => { for (let i = 0; i < k; i++) run('INSERT INTO violations(sales_id,date,type) VALUES(?,?,?)', sid, addDays(t, -i * 3), i % 2 ? 'Telat kembali istirahat' : 'Telat masuk'); });
  run("INSERT INTO customers(name,phone,address,sales_id,channel,price_group,tempo_days,approved,created_at) VALUES('Toko Baru Sentosa','081299990000','Jl. Baru 1',4,'Eceran','Jbr',14,0,?)", t);
  console.log('Data contoh dibuat.');
};
