# ⚡ ST-Cache-Optimizer · Tối ưu hóa Cache SillyTavern

Làm cho các prompt mà SillyTavern gửi đi **có phần mở đầu giữa hai lượt giống nhau từng chữ một càng nhiều càng tốt**, từ đó kích hoạt cache ngầm của Gemini / Vertex AI (và các loại cache tính phí theo tiền tố khác). Các token đầu vào trúng cache thường chỉ bị tính phí bằng một phần nhỏ so với giá gốc (Vertex Gemini là 1/20).

**Không sửa bất kỳ file nào**: Worldbook, preset, thẻ nhân vật (character card) đều được giữ nguyên. Extension chỉ điều chỉnh trực tiếp request hiện tại mỗi khi generate, tắt công tắc là lập tức khôi phục như cũ.

## Tại sao tỷ lệ hit cache lại là 0

Cache của Vertex / Gemini có hai quy tắc (đã test thực tế):

1. **System prompt ở đầu** (toàn bộ các tin nhắn system trước tin nhắn hội thoại đầu tiên) bắt buộc phải **giống nhau từng chữ một cả đoạn**, sai một chữ là trượt cache cả đoạn.
2. Nội dung sau system prompt sẽ hit cache theo **tiền tố (prefix)**, gặp chữ khác biệt đầu tiên là dừng.

Các thẻ nhân vật và preset thông thường lại vô tình vi phạm quy tắc số 1:

| Những thứ thay đổi mỗi lượt | Vị trí thường gặp |
|---|---|
| Các entry worldbook được kích hoạt bằng từ khóa (nhắc đến cái gì thì chèn cái đó) | Trước / Sau định nghĩa nhân vật → System prompt |
| Các block biến như MVU (`<status_current_variables>`), macro ngẫu nhiên, macro thời gian | Các entry worldbook thường trú |
| Tóm tắt của extension bộ nhớ (như "Bản tóm tắt bí mật của hệ thống bộ nhớ" trong Sổ tay Peabo) | Đầu lịch sử chat → System prompt |
| Các entry được chèn vào giữa lịch sử chat theo độ sâu (depth) | Cứ thêm một lượt là vị trí lại lùi về sau, ghi đè lên tiền tố của lượt trước |

## Nó làm được gì

1. **Điều chỉnh trực tiếp Worldbook** (`WORLDINFO_ENTRIES_LOADED`, chỉ sửa bản sao tạm thời của lần quét này)
   - **Các entry từ khóa**, **các entry thường trú dễ thay đổi** (Biến MVU, macro ngẫu nhiên/thời gian, kích hoạt theo xác suất, dính (sticky)/hồi chiêu (cooldown)/độ trễ (delay)) nằm trước/sau định nghĩa nhân vật → Độ sâu trong chat bằng 0, và được bọc lại bằng `<Cài đặt liên quan đến cốt truyện hiện tại>`.
   - **Các entry từ khóa / entry dễ thay đổi** được chèn theo độ sâu → Độ sâu bằng 0 (Khi độ sâu được thiết lập lớn hơn cả lịch sử chat, chúng sẽ rơi vào system prompt).
   - Các **quy tắc thường trú có nội dung cố định**, được chèn theo độ sâu / Author's Note → Đặt trước lịch sử chat: Nếu "Trước định nghĩa nhân vật" của preset nằm trước lịch sử chat thì cho vào đó, nếu không thì chèn lên đầu lịch sử chat và bọc lại bằng `<Cài đặt cố định>`.
   - Các định dạng đầu ra, jailbreak và những entry bắt buộc phải để ở cuối thì giữ nguyên vị trí (có thể dùng regex trong cài đặt để điều chỉnh).
2. **Sắp xếp lại trước khi gửi** (`CHAT_COMPLETION_PROMPT_READY`)
   - Dùng tin nhắn chat thực tế để đối chiếu, nhận diện phạm vi lịch sử chat thực sự trong prompt (các đoạn hội thoại giả, quy tắc, tài liệu ở đầu preset đều không tính).
   - Các block system chèn giữa lịch sử chat, các block dễ thay đổi nằm trước lịch sử chat → Chuyển xuống sau lịch sử chat, vị trí này gần với nơi generate nhất, độ chú ý (attention) cũng cao nhất.
3. **Tự động học hỏi**: Nếu một block nào đó trong system prompt thay đổi nội dung giữa hai lượt, nó sẽ ghi nhớ phần mở đầu của block đó, sau này sẽ tự động chuyển nó xuống sau lịch sử chat để thích ứng với các preset lạ.
4. **Kiểm tra độ ổn định miễn phí**: Chỉ lắp ráp, không gửi đi, mô phỏng prompt của "lượt trước" và "lượt này", báo cáo xem system prompt có nhất quán không, tỷ lệ tiền tố giống nhau giữa hai lượt là bao nhiêu, và điểm khác biệt đầu tiên nằm ở đâu.

## Cài đặt

SillyTavern → Extensions → Install Extension, điền địa chỉ của repository này vào; hoặc đặt thư mục này vào
`public/scripts/extensions/third-party/ST-Cache-Optimizer/`, rồi tải lại trang.

## Sử dụng

- **Công tắc**: Mục "Tối ưu hóa Cache: Bật/Tắt" trong menu cây đũa thần ở góc dưới bên trái, bấm một cái là có thể bật hoặc tắt (khi tắt, biểu tượng tia sét sẽ tối đi); trong bảng cài đặt extension cũng có hộp kiểm (checkbox).
- Sau khi đổi thẻ nhân vật mới / preset mới, hãy bấm "Kiểm tra độ ổn định của cache (miễn phí)":
  - "System prompt hai lượt nhất quán" phải là ✅ thì mới hit cache được; nếu là ❌ nó sẽ liệt kê các block bị thay đổi.
  - "Tiền tố giống nhau giữa hai lượt" càng cao thì càng tiết kiệm.
- Khi dùng kèm với extension bộ nhớ, hãy thiết lập để các tin nhắn cũ **gộp lại thành đợt rồi thu gọn** (cứ mỗi N lượt thì thu gọn một lần) thay vì trượt theo từng tin nhắn, như vậy phần đầu của lịch sử chat mới giữ được sự cố định.

## Thử nghiệm thực tế (Vertex AI · gemini-4-argon, một thẻ nhân vật dài khoảng 140k token)

| | Trúng cache |
|---|---|
| Trước khi tối ưu | 0% (Liên tục hơn 30 lượt) |
| Sau khi tối ưu | 40.2% (57,344 trên tổng 142,701) |

Trong bài kiểm tra miễn phí (chỉ lắp ráp không gửi), tiền tố giống nhau giữa hai lượt:

| Thẻ | Tắt | Bật |
|---|---|---|
| Bài thơ định mệnh và khúc ca hoàng hôn (Worldbook cỡ lớn + MVU + Sổ tay Peabo) | 6.8%, System prompt ❌ | 70.3%, ✅ |
| Một thẻ khác có Worldbook (Entry động với độ sâu 10000) | 7.0%, System prompt ❌ | 68.1%, ✅ |
| Thẻ không có Worldbook | 50.0% | 50.0% (Không có tác dụng phụ) |

## Các preset khác nhau (Cùng một thẻ dài, cùng một đoạn chat, kiểm tra miễn phí)

| Preset | Tiền tố giống nhau giữa hai lượt (Sau khi bật) |
|---|---|
| ARYN-16 | 71.5% |
| linux 1.3 | 64.4% |
| NVWA-Chaos-2-TT | 76.5% |
| Reborn 2.3 | 70.6% |
| Remini WHALE 1.6.0 | 69.5% |
| v0.8 | 70.2% |
| Meowzilla 0808 | 70.5% |

Khi tắt, các preset này đa phần chỉ đạt 6%~21%, system prompt cũng thay đổi sau mỗi lượt.

## Lưu ý

- Chỉ hỗ trợ API hoàn thành hội thoại (Chat Completion).
- Lượt đầu tiên sau khi đổi cài đặt / chuyển preset / bật tắt entry chắc chắn sẽ không trúng cache; khoảng cách giữa hai lượt quá lâu thì cache cũng sẽ hết hạn.
- Các entry từ khóa bị dời ra sau lịch sử chat, vị trí mà model tham chiếu chúng đã thay đổi, nhìn chung ảnh hưởng rất nhỏ; nếu bạn để ý chuyện này thì cứ tắt "Điều chỉnh trực tiếp Worldbook" đi là được.

## Giấy phép

MIT