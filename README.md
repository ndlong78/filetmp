# filetmp — Temp Text Store

Lưu text tạm thời (tối đa 1 giờ), đồng bộ mã hoá đầu-cuối giữa các trình duyệt. Live: https://txt.no.id.vn/

- **Lưu cục bộ**: IndexedDB trên trình duyệt đang dùng; tự xoá khi hết hạn.
- **Mã đồng bộ** (20 ký tự): mọi trình duyệt nhập cùng mã thấy chung danh sách, cập nhật realtime qua WebSocket.
  PBKDF2(mã) → khoá AES-256-GCM (ở lại trình duyệt) + room id (gửi server). Server chỉ thấy room id + ciphertext.
- **Chia sẻ**: link một lần `#s=id.key` — mã hoá với khoá ngẫu nhiên nằm trong phần `#` của link.
- **Link nhúng** (`#d=`, nội dung không mã hoá trong URL): tắt mặc định, bật bằng `TEMP_TEXT_EMBED` trong `public/config.js`.

| Đường dẫn | Nội dung |
|---|---|
| `public/` | trang: `index.html`, `app.js`, `style.css`, `config.js`, `_headers` (CSP, HSTS…) |
| `worker/worker.js` | API + Durable Object `Room` |
| `wrangler.toml` | config deploy Worker `txt` |
| `tests/` | Playwright: API + 2 trình duyệt |
| `worker/README.md` | **vận hành**: deploy, Cloudflare Access/WAF, kiểm tra, rollback, xử lý sự cố |

```bash
npm ci && npm run dev    # http://localhost:8787
npm test                 # cần: npx playwright install chromium
```
