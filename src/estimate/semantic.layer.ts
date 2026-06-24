import { Sheet, Workbook, Material, EntityMap } from './estimate.types';
import { detectSheetType } from './rule-detector';

export function syncWorkbookToSemantic(workbook: Workbook): {
  materials: Material[];
  entityMaps: EntityMap[];
} {
  const materials: Material[] = [];
  const entityMaps: EntityMap[] = [];

  if (!workbook.sheets) return { materials, entityMaps };

  workbook.sheets.forEach((sheet) => {
    const { sheetType } = detectSheetType(sheet);
    sheet.metadata = { ...sheet.metadata, sheetType };

    if (sheetType === 'material') {
      const cellData = sheet.data?.cellData;
      if (!cellData) return;

      let headerRowIdx = -1;
      let colMap = { code: -1, name: -1, unit: -1, price: -1 };

      const rows = Object.keys(cellData);
      for (const rKey of rows) {
        const row = cellData[rKey];
        if (!row) continue;

        let hasCode = false;
        let hasName = false;
        let hasPrice = false;

        Object.keys(row).forEach((cKey) => {
          const cell = row[cKey];
          const val = String(cell?.v || cell?.m || '').trim().toLowerCase();
          if (val.includes('mã') || val.includes('code')) {
            colMap.code = Number(cKey);
            hasCode = true;
          }
          if (val.includes('tên') || val.includes('name')) {
            colMap.name = Number(cKey);
            hasName = true;
          }
          if (val.includes('đơn vị') || val.includes('unit')) {
            colMap.unit = Number(cKey);
          }
          if (val.includes('giá') || val.includes('price')) {
            colMap.price = Number(cKey);
            hasPrice = true;
          }
        });

        if (hasCode && hasName && hasPrice) {
          headerRowIdx = Number(rKey);
          break;
        }
      }

      if (headerRowIdx !== -1) {
        rows.forEach((rKey) => {
          const rIdx = Number(rKey);
          if (rIdx <= headerRowIdx) return;

          const row = cellData[rKey];
          if (!row) return;

          const code = String(row[String(colMap.code)]?.v || '').trim();
          const name = String(row[String(colMap.name)]?.v || '').trim();
          const unit = String(row[String(colMap.unit)]?.v || '').trim();
          const priceVal = row[String(colMap.price)]?.v;
          const price = typeof priceVal === 'number' ? priceVal : Number(priceVal) || 0;

          if (code && name) {
            const materialId = `mat_${sheet.id}_${rKey}`;
            const material: Material = {
              id: materialId,
              code,
              name,
              unit,
              price,
            };
            materials.push(material);

            const map: EntityMap = {
              entityId: materialId,
              sheetId: sheet.id,
              semanticPath: `materials[${materials.length - 1}]`,
            };
            entityMaps.push(map);
          }
        });
      }
    }
  });

  return { materials, entityMaps };
}
