// Tối ưu hóa Cache (Cache Optimizer) v2
//
// Cache ngầm của Gemini / Vertex (và hầu hết các cache tính phí theo tiền tố) yêu cầu:
//   - System prompt ở đầu (tất cả tin nhắn system trước tin nhắn hội thoại đầu tiên) mỗi lượt phải giống nhau từng chữ một;
//   - Nội dung phía sau hit cache theo tiền tố, mỗi lượt tốt nhất chỉ nên nối thêm vào cuối.
// Extension này hoạt động trên bất kỳ preset / worldbook nào mà không làm thay đổi bất kỳ file nào:
//   1. Điều chỉnh trực tiếp Worldbook (WORLDINFO_ENTRIES_LOADED, chỉ sửa bản sao tạm thời của lần quét này):
//      - Các entry từ khóa "Trước/Sau định nghĩa nhân vật", các entry thường trú dễ thay đổi (Biến MVU, macro ngẫu nhiên, kích hoạt theo xác suất) → Độ sâu trong chat bằng 0,
//        bên ngoài được bọc bằng <Cài đặt liên quan đến cốt truyện hiện tại>;
//      - Các entry thường trú có nội dung cố định, được chèn theo độ sâu / Author's Note → Trước định nghĩa nhân vật (để đưa vào system prompt cố định).
//   2. Sắp xếp lại trước khi gửi (CHAT_COMPLETION_PROMPT_READY): Các block system giữa lịch sử chat, các block dễ thay đổi trong system prompt
//      → Cuối lịch sử chat (trước thẻ "</Lịch sử chat>", nếu không có thẻ này thì đặt trước tin nhắn người dùng mới nhất).
//   3. Tự động học hỏi: Nếu một block trong system prompt thay đổi giữa hai lượt, ghi nhớ đặc điểm phần mở đầu, sau này tự động chuyển xuống sau lịch sử chat.
//   4. Kiểm tra độ ổn định miễn phí: Chỉ lắp ráp không gửi, so sánh prompt của "lượt trước" và "lượt này", báo cáo tỷ lệ có thể hit cache.

const MODULE = 'cacheOptimizer';
const DEFAULTS = Object.freeze({
    enabled: true,
    routeWorldInfo: true,
    hoistStatic: true,
    learn: true,
    volatileHeads: ['〔Bản tóm tắt bí mật của hệ thống bộ nhớ'],
    learnedHeads: [],
    keepPatterns: 'output_format|Force_Structured|^<\\/?Format>|jailbreak|phá vỡ giới hạn',
});
const WRAP_OPEN = '<Cài đặt liên quan đến cốt truyện hiện tại>';
const WRAP_CLOSE = '</Cài đặt liên quan đến cốt truyện hiện tại>';
const WRAP_WORLD = '__cache_optimizer__';
const STATIC_OPEN = '<Cài đặt cố định>';
const STATIC_CLOSE = '</Cài đặt cố định>';
// Sâu hơn bất kỳ lịch sử chat nào: Chèn vào đầu lịch sử chat
const TOP_DEPTH = 99999;
const POS = { before: 0, after: 1, anTop: 2, anBottom: 3, atDepth: 4, emTop: 5, emBottom: 6, outlet: 7 };
const ROLE_SYSTEM = 0;
const HOIST_ORDER_BASE = 100000;
const MAX_LEARNED = 30;
// Các entry thường trú có xuất hiện những thứ này sẽ được coi là có thể thay đổi mỗi lượt. Việc đọc cấu hình cố định bằng {{getvar::xx}} không tính: Chúng cơ bản là không đổi sau khi được cài đặt lúc ban đầu;
// Những thứ thực sự thay đổi mỗi lượt là các biến cấp tin nhắn như MVU (stat_data / getMessageVar), ngẫu nhiên, thời gian, tin nhắn mới nhất.
const DYNAMIC_EJS = /stat_data|getMessageVar|getvar\(\s*['"`]stat_data|random|Math\.|Date|roll|_\.(sample|shuffle)|lastUserMessage|lastCharMessage|chat\[|incvar|addvar/;
const DYNAMIC_MACRO = /\{\{(roll|random|pick|time|date|weekday|isotime|isodate|datetimeformat|idle_duration|lastMessage|lastUserMessage|lastCharMessage|lastMessageId)/i;
// Block biến MVU là "thẻ (tag) theo sau ngay bởi mã template"; các entry quy tắc chỉ nhắc đến tên thẻ trong nội dung thì không tính
const DYNAMIC_TAG = /<status_current_variables>\s*(<%|\{\{)/i;

let lastRun = 'Chưa gửi request nào';
let lastSystemBlocks = null;

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= structuredClone(DEFAULTS);
    for (const [key, value] of Object.entries(DEFAULTS)) {
        all[MODULE][key] ??= structuredClone(value);
    }
    return all[MODULE];
}

function save() {
    ctx().saveSettingsDebounced();
}

function text(message) {
    return typeof message?.content === 'string' ? message.content : '';
}

function keepRegex() {
    try {
        return new RegExp(settings().keepPatterns, 'im');
    } catch {
        return new RegExp(DEFAULTS.keepPatterns, 'im');
    }
}

// ───────────────────────── 1. Điều chỉnh trực tiếp Worldbook ─────────────────────────

function isDynamicEntry(entry) {
    const content = String(entry.content ?? '');
    const ejs = content.match(/<%[\s\S]*?%>/g) ?? [];
    if (ejs.some(block => DYNAMIC_EJS.test(block))) return true;
    if (DYNAMIC_MACRO.test(content) || DYNAMIC_TAG.test(content)) return true;
    // Kích hoạt theo xác suất, dính (sticky)/hồi chiêu (cooldown)/độ trễ (delay) đều làm cho entry lúc có lúc không
    if (entry.useProbability && Number(entry.probability ?? 100) < 100) return true;
    if (Number(entry.sticky) > 0 || Number(entry.cooldown) > 0 || Number(entry.delay) > 0) return true;
    return false;
}

/** Một module nào đó trong preset (như worldInfoBefore) có nằm trước lịch sử chat hay không; nếu không tìm thấy thì xử lý theo cấu trúc phổ biến (trước) */
function presetSlotBeforeHistory(identifier) {
    const orders = ctx().chatCompletionSettings?.prompt_order ?? [];
    const order = (orders.find(o => o.character_id === 100001) ?? orders[0])?.order ?? [];
    const index = id => order.findIndex(e => e.identifier === id && e.enabled !== false);
    const slot = index(identifier), history = index('chatHistory');
    if (slot < 0 || history < 0) return true;
    return slot < history;
}

function routeEntries(lists) {
    const s = settings();
    if (!s.enabled || !s.routeWorldInfo) return;
    const keep = keepRegex();
    // Có những preset đặt vị trí Worldbook sau lịch sử chat: Nội dung ở đó mỗi lượt đều xếp sau tin nhắn mới, không bao giờ hit cache được.
    // Lúc này, các cài đặt cố định sẽ được chuyển lên chèn ở đầu lịch sử chat (độ sâu TOP_DEPTH), bất kể preset sắp xếp thế nào thì nó vẫn nằm trước lịch sử chat.
    const beforeSlotOk = presetSlotBeforeHistory('worldInfoBefore');
    const afterSlotOk = presetSlotBeforeHistory('worldInfoAfter');
    let moved = 0, template = null, target = null;
    let topMoved = 0, topTemplate = null, topTarget = null;
    const toTop = (e, list, order) => {
        Object.assign(e, { position: POS.atDepth, depth: TOP_DEPTH, role: ROLE_SYSTEM, order });
        topMoved++;
        topTemplate ??= e;
        topTarget ??= list;
    };

    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const e of list) {
            if (!e || e.disable || e.world === WRAP_WORLD) continue;
            // Chỉ xem tên entry và dòng đầu tiên của nội dung, tránh trường hợp nhắc đến từ khóa trong nội dung bị nhận diện nhầm
            const firstLine = String(e.content ?? '').trimStart().split('\n', 1)[0];
            if (keep.test(String(e.comment ?? '')) || keep.test(firstLine)) continue;
            const pos = Number(e.position);
            if (pos === POS.before || pos === POS.after) {
                // Entry từ khóa lúc có lúc không, entry thường trú động thay đổi mỗi lượt: Đều không thể giữ lại trong system prompt
                if (!e.constant || isDynamicEntry(e)) {
                    Object.assign(e, { position: POS.atDepth, depth: 0, role: ROLE_SYSTEM });
                    moved++;
                    template ??= e;
                    target ??= list;
                } else if (pos === POS.before ? !beforeSlotOk : !afterSlotOk) {
                    toTop(e, list, (pos === POS.after ? 50000 : 0) + (Number(e.order) || 0));
                }
            } else if (pos === POS.atDepth && (!e.constant || isDynamicEntry(e))) {
                // Các entry theo độ sâu dễ thay đổi sẽ được đưa về độ sâu 0: Khi độ sâu được thiết lập lớn hơn cả lịch sử chat thì nó sẽ rơi vào system prompt,
                // Nếu đặt ở giữa thì cũng sẽ bị đẩy lùi theo từng lượt và ghi đè tiền tố; độ sâu 0 sau đó sẽ được tính năng sắp xếp lại trước khi gửi chuyển xuống cuối lịch sử chat
                if (Number(e.depth) !== 0) {
                    e.depth = 0;
                    moved++;
                }
            } else if (s.hoistStatic && e.constant && !isDynamicEntry(e)
                && (pos === POS.atDepth || pos === POS.anTop || pos === POS.anBottom)) {
                // Các quy tắc cố định được đưa lên trước lịch sử chat; sắp xếp theo độ sâu gốc từ sâu đến nông, sau đó sắp xếp theo order, giữ nguyên thứ tự tương đối ban đầu
                const depth = pos === POS.atDepth ? Number(e.depth) || 0 : 0;
                const order = HOIST_ORDER_BASE + (100 - Math.min(depth, 99)) * 1000 + (Number(e.order) || 0);
                if (beforeSlotOk) Object.assign(e, { position: POS.before, order });
                else toTop(e, list, order);
            }
        }
    }

    const wrap = (from, uid, content, order, depth) => ({
        ...from, uid, world: WRAP_WORLD, comment: content, content, order,
        key: [], keysecondary: [], constant: true, disable: false, selective: false,
        useProbability: false, probability: 100, group: '', groupOverride: false,
        sticky: 0, cooldown: 0, delay: 0, position: POS.atDepth, depth, role: ROLE_SYSTEM,
        excludeRecursion: true, preventRecursion: true,
    });
    if (moved && template && target) {
        target.push(wrap(template, -910001, WRAP_OPEN, -1000000, 0), wrap(template, -910002, WRAP_CLOSE, 1000000, 0));
    }
    if (topMoved && topTemplate && topTarget) {
        topTarget.push(wrap(topTemplate, -910003, STATIC_OPEN, -1000000, TOP_DEPTH), wrap(topTemplate, -910004, STATIC_CLOSE, 1000000, TOP_DEPTH));
    }
}

// ───────────────────────── 2. Sắp xếp lại trước khi gửi + 3. Tự động học hỏi ─────────────────────────

function headOf(message) {
    return text(message).trimStart().split('\n', 1)[0].slice(0, 40);
}

function isVolatileHead(head) {
    const { volatileHeads, learnedHeads } = settings();
    return [...volatileHeads, ...learnedHeads].some(h => h && head.startsWith(h));
}

function normalize(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Lấy vài đoạn văn bản từ các tin nhắn chat thực tế gần đây, dùng để nhận diện đâu là lịch sử chat trong prompt */
function historySnippets() {
    return (ctx().chat ?? [])
        .filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim())
        .slice(-60)
        .map(m => {
            const t = normalize(m.mes);
            if (t.length <= 60) return [t];
            // Lấy đoạn giữa: Phần đầu thường là chuỗi suy luận (Chain of Thought), phần cuối thường là block biến, cả hai đều có thể bị xóa bởi regex
            return [0.3, 0.5, 0.7].map(p => t.slice(Math.floor(t.length * p), Math.floor(t.length * p) + 30));
        });
}

/**
 * Tìm phạm vi thực sự của lịch sử chat trong prompt. Nhiều preset đặt các đoạn hội thoại giả user/assistant, quy tắc và tài liệu trước lịch sử chat,
 * không thể lấy "tin nhắn không phải system đầu tiên" làm phần mở đầu của lịch sử chat, nên phải đối chiếu từng dòng với tin nhắn chat thực tế.
 */
function findHistoryRange(chat) {
    const snippets = historySnippets();
    if (!snippets.length) return null;
    let start = -1, end = -1;
    chat.forEach((m, i) => {
        if (m.role === 'system') return;
        const t = normalize(text(m));
        if (t && snippets.some(list => list.some(s => s && t.includes(s)))) {
            if (start < 0) start = i;
            end = i;
        }
    });
    return start < 0 ? null : { start, end };
}

function reorder(chat) {
    const range = findHistoryRange(chat);
    const firstTurn = chat.findIndex(m => m.role !== 'system');
    // Khi không nhận diện được lịch sử chat thì lùi về quy tắc cũ: Nằm giữa tin nhắn không phải system đầu tiên và tin nhắn người dùng cuối cùng
    const start = range ? range.start : firstTurn;
    const end = range ? range.end : chat.findLastIndex(m => m.role === 'user');
    if (start < 0 || end < 0) return 0;
    const anchor = chat[end];

    const moved = [];
    // Block system chèn vào giữa lịch sử chat: Mỗi lượt qua đi vị trí lại lùi về sau, sẽ ghi đè lên tiền tố của lượt trước
    for (let i = end - 1; i > start; i--) {
        // Block cài đặt cố định được chèn ở đầu lịch sử chat là thứ cần được giữ ở phía trước
        if (chat[i].role === 'system' && !text(chat[i]).trimStart().startsWith(STATIC_OPEN)) moved.unshift(...chat.splice(i, 1));
    }
    // Block dễ thay đổi nằm trước lịch sử chat (Tóm tắt lịch sử của Sổ tay Peabo, block dễ thay đổi đã học được, block Worldbook động được điều chỉnh trực tiếp)
    for (let i = start - 1; i >= 0; i--) {
        const t = text(chat[i]).trimStart();
        if (chat[i].role === 'system' && (isVolatileHead(headOf(chat[i])) || t.startsWith(WRAP_OPEN))) moved.unshift(...chat.splice(i, 1));
    }
    if (!moved.length) return 0;

    const at = chat.indexOf(anchor);
    // Đã nhận diện được lịch sử chat: Đặt sau nó; nếu không thì đặt trước tin nhắn người dùng cuối cùng
    chat.splice(range ? at + 1 : at, 0, ...moved);
    return moved.length;
}

/** Trong khu vực cố định trước lịch sử chat, nội dung của các block có cùng phần mở đầu bị thay đổi → Ghi nhớ là dễ thay đổi, từ lượt sau chuyển xuống sau lịch sử chat */
function learnFrom(chat) {
    const s = settings();
    if (!s.learn) return [];
    const range = findHistoryRange(chat);
    const firstTurn = chat.findIndex(m => m.role !== 'system');
    const stop = range ? range.start : (firstTurn < 0 ? chat.length : firstTurn);
    const blocks = chat.slice(0, stop).filter(m => m.role === 'system').map(m => ({ head: headOf(m), body: text(m) }));
    const learned = [];
    if (lastSystemBlocks && lastSystemBlocks.chatId === ctx().getCurrentChatId()) {
        const prev = new Map(lastSystemBlocks.blocks.map(b => [b.head, b.body]));
        for (const b of blocks) {
            if (b.head.length < 4 || !prev.has(b.head) || prev.get(b.head) === b.body || isVolatileHead(b.head)) continue;
            s.learnedHeads.push(b.head);
            learned.push(b.head);
        }
        if (learned.length) {
            s.learnedHeads = s.learnedHeads.slice(-MAX_LEARNED);
            save();
        }
    }
    lastSystemBlocks = { chatId: ctx().getCurrentChatId(), blocks };
    return learned;
}

function onPromptReady(data) {
    if (!settings().enabled || !Array.isArray(data?.chat)) return;
    const n = reorder(data.chat);
    if (data.dryRun) return;
    const learned = learnFrom(data.chat);
    lastRun = `${new Date().toLocaleTimeString()} Sắp xếp lại trước khi gửi: Đã di chuyển ${n} block`
        + (learned.length ? `; Học thêm được ${learned.length} block dễ thay đổi (sẽ có hiệu lực ở lượt tiếp theo)` : '');
    $('#cacheopt_last').text(lastRun);
    renderLearned();
}

// ───────────────────────── 4. Kiểm tra độ ổn định miễn phí ─────────────────────────

async function captureDryRun() {
    const c = ctx();
    let captured = null;
    const handler = data => { captured = structuredClone(data.chat); };
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
    try {
        await c.generate('normal', {}, true);
    } finally {
        c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
    }
    return captured;
}

async function checkStability() {
    const c = ctx();
    const report = $('#cacheopt_report');
    if (c.mainApi !== 'openai') return report.text('Chỉ hỗ trợ API hoàn thành hội thoại (Chat Completion).');
    const lastUser = c.chat.findLastIndex(m => m.is_user);
    if (lastUser < 2) return report.text('Lịch sử chat quá ngắn, cần ít nhất hai lượt hội thoại.');
    report.text('Đang kiểm tra (Chỉ lắp ráp, không gửi, không tốn tiền)...');

    const original = c.chat.length;
    let previous;
    const removed = c.chat.splice(lastUser - 1);
    try {
        previous = await captureDryRun();
    } finally {
        c.chat.push(...removed);
    }
    const current = await captureDryRun();
    if (c.chat.length !== original || !previous || !current) return report.text('Kiểm tra thất bại: Không thể lắp ráp ra prompt.');

    const flat = list => list.map(m => `[${m.role}]${text(m)}`).join('\n');
    const lead = list => { let k = 0; while (k < list.length && list[k].role === 'system') k++; return k; };
    const a = flat(previous), b = flat(current);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    let at = 0, acc = 0;
    for (; at < current.length; at++) {
        acc += flat([current[at]]).length + 1;
        if (acc > i) break;
    }
    const sysPrev = previous.slice(0, lead(previous)), sysCur = current.slice(0, lead(current));
    const systemSame = flat(sysPrev) === flat(sysCur);
    const changed = systemSame ? [] : sysCur.filter((m, k) => text(m) !== text(sysPrev[k])).map(headOf);
    report.text([
        `System prompt hai lượt nhất quán: ${systemSame ? '✅ Có' : '❌ Không (Vertex/Gemini sẽ trượt cache cả lượt)'}`,
        changed.length ? `Các block thay đổi trong system prompt: ${changed.slice(0, 5).join(' / ')}` : '',
        `Tiền tố giống nhau giữa hai lượt: ${(i / b.length * 100).toFixed(1)}% (khoảng ${i.toLocaleString()} / ${b.length.toLocaleString()} ký tự)`,
        `Điểm khác biệt đầu tiên xuất hiện ở tin nhắn thứ ${at + 1} (${current[at]?.role}):`,
        text(current[at]).slice(0, 80).replace(/\s+/g, ' '),
        'Lưu ý: Mô phỏng không bao gồm những thay đổi thực tế xảy ra mỗi lượt như "thu gọn tin nhắn cũ" của extension bộ nhớ.',
        settings().enabled ? '' : '(Hiện chưa được bật, hãy bật lên rồi kiểm tra lại lần nữa để so sánh hiệu quả)',
    ].filter(Boolean).join('\n'));
}

// ───────────────────────── Giao diện ─────────────────────────

function setEnabled(value) {
    settings().enabled = value;
    save();
    $('#cacheopt_enabled').prop('checked', value);
    $('#cacheopt_menu_label').text(`Tối ưu hóa Cache: ${value ? 'Bật' : 'Tắt'}`);
    $('#cacheopt_menu .extensionsMenuExtensionButton').css('opacity', value ? '' : '0.4');
}

function renderLearned() {
    const list = settings().learnedHeads;
    $('#cacheopt_learned').text(list.length ? `Các block dễ thay đổi đã học được (${list.length}): ${list.join(' / ')}` : 'Các block dễ thay đổi đã học được: Chưa có');
}

function bindCheckbox(id, key) {
    $(id).prop('checked', !!settings()[key]).on('input', function () {
        settings()[key] = !!$(this).prop('checked');
        save();
    });
}

function renderSettings() {
    const html = `
    <div class="cacheopt-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>⚡ Tối ưu hóa Cache</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label"><input id="cacheopt_enabled" type="checkbox"> Bật tối ưu hóa Cache</label>
          <label class="checkbox_label"><input id="cacheopt_route" type="checkbox"> Điều chỉnh trực tiếp Worldbook: Chuyển các entry từ khóa / entry dễ thay đổi vào chat (không sửa file)</label>
          <label class="checkbox_label"><input id="cacheopt_hoist" type="checkbox"> Đưa các entry quy tắc cố định lên trước vào system prompt</label>
          <label class="checkbox_label"><input id="cacheopt_learn" type="checkbox"> Tự động học hỏi các block dễ thay đổi trong system prompt</label>
          <label class="cacheopt-label">Các entry giữ nguyên vị trí (Regex, khớp với tên entry hoặc phần mở đầu nội dung)
            <input id="cacheopt_keep" class="text_pole" type="text">
          </label>
          <div class="cacheopt-row">
            <div id="cacheopt_check" class="menu_button">Kiểm tra độ ổn định của cache (Miễn phí)</div>
            <div id="cacheopt_forget" class="menu_button">Xóa các block dễ thay đổi đã học</div>
          </div>
          <div id="cacheopt_learned" class="cacheopt-hint"></div>
          <div id="cacheopt_last" class="cacheopt-hint"></div>
          <div id="cacheopt_report" class="cacheopt-report">Bấm "Kiểm tra độ ổn định của cache" để xem tỷ lệ có thể hit cache giữa hai lượt.</div>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#cacheopt_enabled').prop('checked', settings().enabled).on('input', function () { setEnabled(!!$(this).prop('checked')); });
    bindCheckbox('#cacheopt_route', 'routeWorldInfo');
    bindCheckbox('#cacheopt_hoist', 'hoistStatic');
    bindCheckbox('#cacheopt_learn', 'learn');
    $('#cacheopt_keep').val(settings().keepPatterns).on('change', function () {
        settings().keepPatterns = String($(this).val());
        save();
    });
    $('#cacheopt_check').on('click', () => checkStability().catch(e => $('#cacheopt_report').text(`Kiểm tra thất bại: ${e?.message || e}`)));
    $('#cacheopt_forget').on('click', () => {
        settings().learnedHeads = [];
        save();
        renderLearned();
    });
    $('#cacheopt_last').text(lastRun);
    renderLearned();

    // Công tắc một chạm ở menu cây đũa thần (góc dưới bên trái), cấu trúc giống với các mục menu có sẵn của SillyTavern
    const item = $(`<div id="cacheopt_wand_container" class="extension_container interactable" tabindex="0">
        <div id="cacheopt_menu" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" title="Công tắc bật tắt nhanh Tối ưu hóa Cache">
          <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div><span id="cacheopt_menu_label"></span></div></div>`);
    item.on('click', () => {
        setEnabled(!settings().enabled);
        toastr.info(`Tối ưu hóa Cache đã được ${settings().enabled ? 'bật' : 'tắt'}`, 'Tối ưu hóa Cache');
    });
    $('#extensionsMenu').append(item);
    setEnabled(settings().enabled);
}

jQuery(() => {
    settings();
    renderSettings();
    const c = ctx();
    c.eventSource.on(c.eventTypes.WORLDINFO_ENTRIES_LOADED, data => {
        routeEntries([data?.globalLore, data?.characterLore, data?.chatLore, data?.personaLore]);
    });
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
});