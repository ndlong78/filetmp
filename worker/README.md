# txt (Worker) — Cloudflare Worker + KV

Backend cho nút **Chia sẻ**: lưu blob đã mã hoá AES-GCM trên trình duyệt (server không có khoá),
KV tự xoá sau tối đa 1 giờ (`expirationTtl`), tối đa 25 MB/bản ghi (sau nén gzip).

## Deploy

Một Worker phục vụ cả trang (`public/`, Static Assets) và API (`/api/*`, `worker/worker.js`) trên `txt.no.id.vn`.
Config: **`wrangler.toml` ở thư mục gốc repo** (để Workers Builds/Git và `wrangler deploy` dùng chung).

```bash
npm i -g wrangler        # cần wrangler >= 4.20 (run_worker_first dạng list)
wrangler login
# chạy ở thư mục gốc repo
wrangler kv namespace create NOTES      # lần đầu: copy "id" vào wrangler.toml (thư mục gốc) (đã điền: 5e91a661…)
wrangler deploy                         # gắn custom domain txt.no.id.vn (zone no.id.vn phải ở Cloudflare)
```

Đổi domain: sửa `routes`, `ALLOWED_ORIGINS` (`wrangler.toml` gốc) và `public/config.js` cho khớp.

### Deploy qua Git (Workers Builds)

Dashboard → Workers & Pages → Worker → Settings → Build:
- **Root directory**: `/` (để trống) · **Deploy command**: `npx wrangler deploy`
- Tên Worker trên Dashboard phải trùng `name` trong `wrangler.toml` (`txt`), nếu khác thì sửa `name` cho khớp.

Dấu hiệu deploy thiếu worker script: `/api/rooms/...` trả **404 body rỗng** (Static Assets), còn Worker cũ trả `{"error":"not found"}`.

## Kiểm tra

```bash
API=https://txt.no.id.vn
TOKEN=$(openssl rand -hex 16)
ID=$(printf 'test' | curl -s -X POST "$API/api/notes" -H "Origin: https://txt.no.id.vn" \
     -H "X-TTL: 120" -H "X-Delete-Token: $TOKEN" --data-binary @- | jq -r .id)
curl -s "$API/api/notes/$ID"                                         # -> test
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$API/api/notes/$ID" -H "X-Delete-Token: $TOKEN"   # -> 204
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/notes/$ID"         # -> 404
```

## Rollback

- Về bản trước: `wrangler rollback` (hoặc Dashboard → Workers → txt → Deployments).
- Tắt chia sẻ server: đặt `window.TEMP_TEXT_API = ''` trong `public/config.js` rồi deploy (Link nhúng vẫn chạy).
- Gỡ hẳn: `wrangler delete` và `wrangler kv namespace delete --binding NOTES`.

## API

| Method | Path | Header | Kết quả |
|---|---|---|---|
| POST | `/api/notes` | `X-TTL` (60–3600 s), `X-Delete-Token` (32 hex) | `201 {id, expiresAt}` |
| GET | `/api/notes/:id` | — | blob, `X-Expires-At`; `404` nếu hết hạn |
| DELETE | `/api/notes/:id` | `X-Delete-Token` | `204` / `403` |
| GET | `/api/rooms/:room` | — | `{notes:[{id,v,expiresAt,size}]}` (index, đọc ~60 s cache KV) |
| PUT | `/api/rooms/:room/:id` | `X-TTL`, `X-Version` | blob mã hoá + cập nhật index |
| GET | `/api/rooms/:room/:id` | — | blob |
| DELETE | `/api/rooms/:room/:id` | — | `204` |

`:room` = 256 bit sinh từ **Mã đồng bộ** bằng PBKDF2 trên trình duyệt (khoá AES là nửa còn lại, không gửi lên server).
Mỗi lần lưu khi đang đồng bộ tốn 2 lần ghi KV (blob + index) → free tier ~500 lần lưu/ngày.

`ALLOWED_ORIGINS` (`wrangler.toml` gốc) chặn POST từ trang khác qua trình duyệt — không chặn được curl.
Free tier KV: 1.000 lần ghi/ngày, 100.000 lần đọc/ngày, 1 GB lưu trữ.
