# Pasang di bas.ornovaintegrasolusi.com

Pasang di VPS Ornova `45.77.36.205`, mengikuti pola `vps-tambah-aplikasi-oee.md`.
Aplikasi ini server Node tanpa dependency dengan database SQLite dalam satu file, jadi tidak perlu
database terpisah. Pemakaian RAM sekitar 40–60 MB.

> **Sebelum dibuka ke internet:** semua password contoh adalah `ois` dan datanya data contoh.
> Untuk demo ke klien ini tidak masalah, tapi jangan dipakai untuk data asli sebelum login
> diperkuat.

## 1. DNS

Di pengelola domain ornovaintegrasolusi.com:

```
Type: A    Name: bas    Value: 45.77.36.205    TTL: 3600
```

Cek: `nslookup bas.ornovaintegrasolusi.com` harus menunjuk ke `45.77.36.205`.

## 2. Ambil kode di server

```bash
ssh -i ~/.ssh/ois_vps_ed25519 root@45.77.36.205
```

```bash
df -h / && free -h
```

Kalau disk sudah di atas 85%, jalankan dulu Langkah 0 di panduan OEE (`docker builder prune -af`).

```bash
git clone https://github.com/chnsetiawan-dev/bumi-ayu-sejati.git /var/www/bas-app
```

Kalau repo-nya privat, pakai token GitHub (`https://<token>@github.com/...`) atau upload dengan scp dari laptop:

```bash
scp -i ~/.ssh/ois_vps_ed25519 -r "./1 sales app/app/"* root@45.77.36.205:/var/www/bas-app/
```

## 3. Tambah service ke docker-compose

```bash
cp /root/docker-compose.yml /root/docker-compose.yml.bak-$(date +%F)
```

Sisipkan tepat sebelum baris `# Declaring all volumes used above` (indentasi 2 spasi):

```yaml
  bas-app:
    image: node:24-alpine
    container_name: bas-app
    restart: always
    working_dir: /app
    command: node server.js
    environment:
      - PORT=3000
      - TZ=Asia/Jakarta
    expose:
      - "3000"
    volumes:
      - /var/www/bas-app:/app
    networks:
      - gso-network
```

Kode dan `data.db` ada di `/var/www/bas-app` di server, jadi data tetap ada walaupun container dibuat ulang.

```bash
docker compose -f /root/docker-compose.yml config > /dev/null && echo "YAML OK"
```

## 4. Jalankan HANYA service ini

```bash
cd /root && docker compose up -d --no-deps bas-app
```

```bash
docker logs bas-app
```

Harus muncul: `Aplikasi Penjualan Bumi Ayu jalan di http://localhost:3000`.

> Jangan pernah `docker compose up -d` tanpa nama service, `--force-recreate`, atau `down`.
> Perintah itu menyentuh webreport, webapi, dan aplikasi lain.

## 5. Hubungkan ke Caddy

```bash
cp /root/Caddyfile /root/Caddyfile.bak-$(date +%F)
```

Tambahkan di **akhir** `/root/Caddyfile`:

```
bas.ornovaintegrasolusi.com {
	encode zstd gzip
	reverse_proxy bas-app:3000

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
}
```

```bash
docker exec caddy caddy validate --config /etc/caddy/Caddyfile && docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## 6. Cek

```bash
curl -I https://bas.ornovaintegrasolusi.com
```

```bash
curl -I https://ois.ornovaintegrasolusi.com && docker ps --format "{{.Names}}\t{{.Status}}"
```

Container lain harus tetap `Up` dengan waktu hidup yang lama.

## Update aplikasi

```bash
cd /var/www/bas-app && git pull && docker exec bas-app npm install --omit=dev && docker restart bas-app
```

`data.db` tidak ikut tertimpa karena masuk `.gitignore`.

## Reset ke data contoh

```bash
docker stop bas-app && rm /var/www/bas-app/data.db && docker start bas-app
```

## Mundur

```bash
docker stop bas-app && docker rm bas-app
cp /root/docker-compose.yml.bak-<tanggal> /root/docker-compose.yml
cp /root/Caddyfile.bak-<tanggal> /root/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## Email notifikasi (opsional)

Email aktif bila variabel ini ditambahkan di blok `environment` service `bas-app`
(lalu `docker compose up -d --no-deps bas-app`):

```yaml
      - APP_URL=https://bas.ornovaintegrasolusi.com
      - SMTP_HOST=smtp.contoh.com
      - SMTP_PORT=587
      - SMTP_USER=notifikasi@contoh.com
      - SMTP_PASS=********
      - SMTP_FROM=Kentang Brokoli <notifikasi@contoh.com>
```

Push notification tidak butuh pengaturan apa pun; kuncinya dibuat otomatis dan disimpan di `data.db`.
