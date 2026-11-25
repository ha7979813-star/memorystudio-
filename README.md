# Lịch làm việc và file sản xuất (bản C)

Website tự triển khai: đăng nhập thật, phân quyền kiểm tra ở máy chủ, file lưu trên máy chủ của bạn.
Không cần cài thư viện ngoài, chỉ cần **Node.js 22.13 trở lên** hoặc Docker.

## Chạy thử trên máy
```bash
ADMIN_PASS=matkhau-cua-ban COOKIE_SECURE=0 npm start
```
Mở http://localhost:3000 và đăng nhập `admin` cùng mật khẩu vừa đặt.
(Nếu không đặt `ADMIN_PASS`, mật khẩu ngẫu nhiên sẽ in ra màn hình ở lần chạy đầu.)

## Triển khai bằng Docker
```bash
cp .env.example .env      # sửa ADMIN_PASS và các giá trị khác
docker compose up -d --build
```
Dữ liệu nằm trong thư mục `./data` (`app.db` và `uploads/`).

### Bật HTTPS (bắt buộc khi dùng thật)
Đặt Caddy phía trước, tự lấy chứng chỉ miễn phí. Ví dụ `Caddyfile`:
```
lich.tencongty.vn {
    request_body { max_size 2GB }
    reverse_proxy 127.0.0.1:3000
}
```
Trong `.env` đặt `COOKIE_SECURE=1` và `TRUST_PROXY=1`. Với nginx cần `client_max_body_size 2g;` và `proxy_request_buffering off;`.

## Phân quyền (máy chủ kiểm tra từng yêu cầu)
| Việc | Admin | Nhân viên |
|---|---|---|
| Xem lịch, hồ sơ nhân sự, danh sách file, tải file | ✅ | ✅ |
| Upload file vào dự án | ✅ | ✅ |
| Sửa lịch, dự án, giao diện | ✅ | ❌ |
| Thêm, sửa, xóa nhân sự và mật khẩu | ✅ | ❌ |
| Đổi tên, xóa file | ✅ | ❌ |

Tài khoản nhân viên do admin tạo ở tab Nhân sự (tên đăng nhập và mật khẩu tối thiểu 8 ký tự). Mật khẩu được băm bằng scrypt, phiên đăng nhập 7 ngày, đăng nhập sai quá 10 lần sẽ bị khóa tạm 10 phút.

## Sao lưu
Sao chép thư mục `data/` (khi dừng ứng dụng, hoặc dùng `sqlite3 app.db ".backup bak.db"`) theo lịch hằng ngày, và lưu một bản ra nơi khác.

## Giới hạn hiện tại
- Một máy chủ duy nhất; dữ liệu đồng bộ giữa các người dùng bằng cách tự làm mới mỗi 15 giây.
- File lưu trên ổ đĩa máy chủ. Muốn lưu lên S3, Google Cloud Storage… thì thay hai chỗ đọc và ghi file trong `server.js` (`/api/files`).
- Chưa có chức năng quên mật khẩu: admin đặt lại mật khẩu ở nút Sửa của nhân sự.
- Nhân viên tự đổi mật khẩu được qua API `/api/me/password` nhưng chưa có nút trên giao diện.
- `node:sqlite` của Node vẫn được Node đánh dấu "thử nghiệm"; nếu muốn ổn định hơn có thể chuyển sang `better-sqlite3`.
