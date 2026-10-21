# filetmp

Form HTML lưu text tạm thời, tự xoá sau tối đa 1 giờ.

Live: https://ndlong78.github.io/filetmp/

- Lưu cục bộ: IndexedDB trên trình duyệt đang dùng.
- **Link nhúng**: nội dung nén nằm trong chính link (`#d=…`), không cần server, ~2 MB link tối đa.
- **Chia sẻ** (server): mã hoá AES-GCM trên trình duyệt, upload lên Cloudflare Worker + KV, khoá chỉ nằm trong link (`#s=id.key`). Cần deploy `worker/` và điền `config.js` — xem [worker/README.md](worker/README.md).
