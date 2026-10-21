# filetmp-api — Cloudflare Worker + KV

Backend cho nút **Chia sẻ**: lưu blob đã mã hoá AES-GCM trên trình duyệt (server không có khoá),
KV tự xoá sau tối đa 1 giờ (`expirationTtl`), tối đa 25 MB/bản ghi (sau nén gzip).

## Deploy (một lần)

```bash
npm i -g wrangler
wrangler login
cd worker
wrangler kv namespace create NOTES      # copy "id" vào wrangler.toml (REPLACE_WITH_KV_NAMESPACE_ID)
wrangler deploy                         # in ra URL: https://filetmp-api.<account>.workers.dev
```

Sau đó sửa `config.js` ở thư mục gốc repo:

```js
window.TEMP_TEXT_API = 'https://filetmp-api.<account>.workers.dev';
```

commit + push `main` → GitHub Pages hiện nút **Chia sẻ**.

## Kiểm tra

```bash
API=https://filetmp-api.<account>.workers.dev
TOKEN=$(openssl rand -hex 16)
ID=$(printf 'test' | curl -s -X POST "$API/api/notes" -H "Origin: https://ndlong78.github.io" \
     -H "X-TTL: 120" -H "X-Delete-Token: $TOKEN" --data-binary @- | jq -r .id)
curl -s "$API/api/notes/$ID"                                         # -> test
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$API/api/notes/$ID" -H "X-Delete-Token: $TOKEN"   # -> 204
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/notes/$ID"         # -> 404
```

## Rollback

- Tắt chia sẻ server: đặt lại `window.TEMP_TEXT_API = ''` (Link nhúng vẫn chạy).
- Gỡ hẳn: `wrangler delete` và `wrangler kv namespace delete --binding NOTES`.

## API

| Method | Path | Header | Kết quả |
|---|---|---|---|
| POST | `/api/notes` | `X-TTL` (60–3600 s), `X-Delete-Token` (32 hex) | `201 {id, expiresAt}` |
| GET | `/api/notes/:id` | — | blob, `X-Expires-At`; `404` nếu hết hạn |
| DELETE | `/api/notes/:id` | `X-Delete-Token` | `204` / `403` |

`ALLOWED_ORIGINS` (wrangler.toml) chặn POST từ trang khác qua trình duyệt — không chặn được curl.
Free tier KV: 1.000 lần ghi/ngày, 100.000 lần đọc/ngày, 1 GB lưu trữ.
