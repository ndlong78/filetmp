# filetmp

Form HTML lưu text tạm thời, tự xoá sau tối đa 1 giờ.

Live: https://txt.no.id.vn/

- `public/` — trang tĩnh (`index.html`, `config.js`), Worker phục vụ qua Static Assets.
- `worker/worker.js` — Cloudflare Worker: `/api/*` + KV, cùng domain với trang. Xem [worker/README.md](worker/README.md).
- `wrangler.toml` — config deploy (thư mục gốc).
- Lưu cục bộ: IndexedDB trên trình duyệt đang dùng.
- **Mã đồng bộ**: các trình duyệt nhập cùng mã thấy chung danh sách (E2E: AES-GCM, khoá PBKDF2 từ mã; server chỉ thấy room id + blob mã hoá).
- **Link nhúng**: nội dung nén nằm trong chính link (`#d=…`), không cần server, ~2 MB link tối đa.
- **Chia sẻ** (server): mã hoá AES-GCM trên trình duyệt, upload lên KV, khoá chỉ nằm trong link (`#s=id.key`).
