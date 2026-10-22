# Vận hành — Worker `txt` (txt.no.id.vn)

Một Worker phục vụ trang tĩnh (`public/`, Static Assets) và API (`/api/*`, `worker/worker.js`).
Config: `wrangler.toml` ở thư mục gốc. Production = branch `main` (Workers Builds tự deploy).

| Thành phần | Lưu trữ | Ghi chú |
|---|---|---|
| Phòng đồng bộ `/api/rooms/*` | Durable Object `Room` (SQLite) | nhất quán mạnh, version do server cấp, WebSocket push, alarm xoá bản ghi hết hạn |
| Link chia sẻ `/api/notes/*` | Workers KV `NOTES` | `expirationTtl` ≤ 1 giờ |
| Giới hạn ghi | Rate Limiting `WRITE_LIMITER` | 30 lần ghi / 60 s / IP |
| Log | Workers Logs (`[observability]`) | Dashboard → Worker `txt` → Logs |

Mọi dữ liệu lưu trên server là ciphertext AES-256-GCM tạo trên trình duyệt; server không có khoá.

## Phát triển & kiểm thử

```bash
npm ci
npm run dev                         # http://localhost:8787 (KV/DO giả lập trong .wrangler/)
npx playwright install chromium     # lần đầu
npm test                            # API + 2 trình duyệt đồng bộ realtime
npm run check                       # cú pháp + wrangler deploy --dry-run
```

Quy trình: branch → PR (CI chạy `npm run check` + `npm test`) → review → merge `main` → Workers Builds deploy.
Bật **branch protection** cho `main` (GitHub → Settings → Branches): require PR + status check `CI / test`.

> Workers Builds trên branch không phải production chạy `wrangler versions upload`, lệnh này **không hỗ trợ
> Durable Object migration** — build preview của PR thêm migration mới sẽ lỗi; build `main` (`wrangler deploy`) vẫn chạy.

## Cấu hình Cloudflare (Dashboard, làm một lần)

1. **Cloudflare Access** — Zero Trust → Access → Applications → Add → Self-hosted
   - Domain `txt.no.id.vn`, path để trống (bảo vệ cả trang lẫn `/api/*`)
   - Policy: Allow → Emails ending in `@<domain công ty>` (hoặc danh sách email), login method One-time PIN
   - Session duration: 24h. Kiểm tra: mở cửa sổ ẩn danh → phải hiện màn hình đăng nhập Access
2. **SSL/TLS → Edge Certificates**: Always Use HTTPS = On, Minimum TLS 1.2, HSTS bật (max-age 12 tháng)
3. **Security → WAF → Rate limiting rules** (lớp ngoài, bổ sung cho `WRITE_LIMITER`):
   `(http.host eq "txt.no.id.vn" and starts_with(http.request.uri.path, "/api/") and http.request.method ne "GET")` → 60 req/phút/IP → Block 10 phút
4. **Notifications**: thêm cảnh báo Workers usage (request, CPU) và billing để biết trước khi chạm quota free

## Kiểm tra sau deploy

```bash
B=https://txt.no.id.vn
curl -sI $B/ | grep -iE 'content-security-policy|strict-transport'        # header bảo mật
curl -s  $B/api/rooms/$(printf 'x%.0s' {1..43})                            # {"notes":[]}
curl -s -o /dev/null -w '%{http_code}\n' $B/wrangler.toml                  # 404
```
(Khi đã bật Access, curl nhận 302 tới trang đăng nhập — đó là đúng.)

## Rollback

- **Code** (không đổi binding/migration): Dashboard → Worker `txt` → Deployments → chọn bản trước → Rollback,
  hoặc `npx wrangler rollback`.
- **Qua mốc Durable Object migration** (vd. về bản trước khi có `Room`): Cloudflare không cho rollback qua migration —
  `git revert` commit lỗi trên `main` (giữ nguyên `class Room` + `[[migrations]]`), CI xanh rồi merge.
- **Sự cố nặng**: tạm đặt `window.TEMP_TEXT_API = false` trong `public/config.js` (trang chỉ lưu cục bộ) và deploy.

## Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Xử lý |
|---|---|---|
| `/api/*` trả 404 body rỗng | deploy chỉ có assets (không thấy `wrangler.toml`) | Build: Root directory `/`, deploy command `npx wrangler deploy` |
| Build lỗi "name … must match" | `name` khác tên Worker | sửa `name` trong `wrangler.toml` |
| `500 server misconfigured` | thiếu binding KV/DO | kiểm tra `[[kv_namespaces]]`, `[[durable_objects.bindings]]` |
| `429 rate limited` | > 30 lần ghi/phút/IP (cả văn phòng dùng chung NAT!) | tăng `simple.limit` trong `[[ratelimits]]` |
| `409 room full` | > 200 bản ghi hoặc > 50 MB trong một phòng | xoá bớt; chỉnh `MAX_ROOM_*` trong `worker.js` |
| Trạng thái "mất kết nối realtime" | WebSocket bị proxy/firewall chặn | vẫn chạy bằng polling 60 s; cho phép `wss://txt.no.id.vn` |

## API

| Method | Path | Header | Kết quả |
|---|---|---|---|
| GET | `/api/rooms/:room` | — | `{notes:[{id,v,expiresAt,size}]}` |
| PUT | `/api/rooms/:room/:id` | `X-TTL` (60–3600) | `{id,v,expiresAt}` — `v` do server cấp, tăng dần |
| GET | `/api/rooms/:room/:id` | — | blob, `X-Version`, `X-Expires-At` |
| DELETE | `/api/rooms/:room/:id` | — | `204` |
| GET (WS) | `/api/rooms/:room/ws` | Upgrade | nhận `{"type":"changed","v":n}`; gửi `ping` → `pong` |
| POST | `/api/notes` | `X-TTL`, `X-Delete-Token` (32 hex) | `201 {id,expiresAt}` |
| GET | `/api/notes/:id` | — | blob |
| DELETE | `/api/notes/:id` | `X-Delete-Token` | `204` / `403` |

Mọi lệnh ghi yêu cầu header `Origin` = chính trang (hoặc nằm trong `ALLOWED_ORIGINS`). Giới hạn: 10 MB/bản ghi,
200 bản ghi và 50 MB/phòng, TTL tối đa 1 giờ. `:room` = 256 bit sinh từ Mã đồng bộ bằng PBKDF2 (200k vòng) trên
trình duyệt; nửa còn lại của PBKDF2 là khoá AES, không bao giờ gửi lên server.
