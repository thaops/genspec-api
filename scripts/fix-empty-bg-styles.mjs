// Dọn dữ liệu cũ: style entry trong registry `_styles` của Univer bị `bg: { rgb: "" }`
// do bug flash animation gọi setBackgroundColor("") — chuỗi rỗng = XOÁ NỀN — rồi auto-save
// persist xuống DB. Bug đã fix ở FE (genspec-web/lib/univer-style.ts + WorkbookEditor.tsx),
// nhưng chỉ chặn TẠO MỚI; các estimate đã lưu vẫn mất màu khi mở lên.
//
// Xử lý: sheets[].data._styles[key].bg.rgb === "" → XOÁ HẲN field `bg` (Univer dùng nền mặc
// định). KHÔNG đoán/bịa màu gốc — màu cũ đã mất khỏi DB, không thể khôi phục.
//
// Idempotent: chạy lại không đổi gì thêm (entry đã xoá `bg` không còn khớp điều kiện).
// Mặc định DRY-RUN (không ghi). Ghi thật chỉ khi truyền --apply.
//
// Usage:
//   node scripts/fix-empty-bg-styles.mjs            # dry-run, chỉ đếm + in
//   node scripts/fix-empty-bg-styles.mjs --apply    # ghi thật xuống DB
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

/** Đọc MONGODB_URI từ .env (dotenv không phải direct dep của repo). */
function readEnvUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  let raw;
  try {
    raw = readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    throw new Error('Không đọc được genspec-api/.env và cũng không có env MONGODB_URI.');
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*MONGODB_URI\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('Không tìm thấy MONGODB_URI trong genspec-api/.env.');
}

/** Xoá field `bg` ở mọi style entry có bg.rgb === "". Trả về số entry đã sửa. */
function cleanStyleRegistry(styles) {
  if (!styles || typeof styles !== 'object') return 0;
  let fixed = 0;
  for (const entry of Object.values(styles)) {
    if (!entry || typeof entry !== 'object') continue;
    const bg = entry.bg;
    // Chỉ động vào bg rỗng đúng nghĩa: { rgb: "" }. bg có màu thật → giữ nguyên.
    if (bg && typeof bg === 'object' && bg.rgb === '') {
      delete entry.bg;
      fixed++;
    }
  }
  return fixed;
}

async function main() {
  const uri = readEnvUri();
  console.log(`Mode: ${APPLY ? 'APPLY (GHI THẬT)' : 'DRY-RUN (không ghi)'}`);
  await mongoose.connect(uri);
  console.log('Đã kết nối MongoDB.\n');

  const col = mongoose.connection.collection('estimates');
  const cursor = col.find({}, { projection: { sheets: 1, name: 1 } });

  let scanned = 0;
  let estimatesHit = 0;
  let sheetsHit = 0;
  let stylesHit = 0;
  const affected = [];

  for await (const doc of cursor) {
    scanned++;
    if (!Array.isArray(doc.sheets) || doc.sheets.length === 0) continue;

    let docStyles = 0;
    let docSheets = 0;
    for (const sheet of doc.sheets) {
      const n = cleanStyleRegistry(sheet?.data?._styles);
      if (n > 0) {
        docSheets++;
        docStyles += n;
      }
    }
    if (docStyles === 0) continue;

    estimatesHit++;
    sheetsHit += docSheets;
    stylesHit += docStyles;
    affected.push({ id: String(doc._id), name: doc.name, sheets: docSheets, styles: docStyles });

    if (APPLY) {
      // Ghi lại nguyên mảng sheets đã được clean in-place ở trên.
      await col.updateOne({ _id: doc._id }, { $set: { sheets: doc.sheets } });
    }
  }

  console.log('--- Estimate bị ảnh hưởng ---');
  if (affected.length === 0) {
    console.log('(không có)');
  } else {
    for (const a of affected) {
      console.log(`  ${a.id}  sheets=${a.sheets} styles=${a.styles}  ${a.name ?? ''}`);
    }
  }

  console.log('\n--- SUMMARY ---');
  console.log(`Đã quét            : ${scanned} estimate`);
  console.log(`Estimate dính bug  : ${estimatesHit}`);
  console.log(`Sheet dính bug     : ${sheetsHit}`);
  console.log(`Style entry dính   : ${stylesHit}`);
  console.log(
    APPLY
      ? `\nĐÃ GHI ${estimatesHit} estimate xuống DB.`
      : '\nDRY-RUN — KHÔNG ghi gì. Chạy lại với --apply để ghi thật.',
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nLỖI:', err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
