export interface WorkItem {
  group: string;
  code?: string;
  name: string;
  required: boolean;
  components: string[];
  notes?: string;
}

export const RESIDENTIAL_CHECKLIST: WorkItem[] = [
  { group: 'Đất', code: 'AF.1', name: 'Đào đất móng', required: true, components: ['Đào đất', 'Vận chuyển đất thừa'] },
  { group: 'Đất', code: 'AF.2', name: 'Đắp đất nền', required: true, components: ['Đắp đất', 'Đầm đất'] },
  {
    group: 'Móng',
    code: 'BA.1',
    name: 'Bê tông lót móng',
    required: true,
    components: ['Bê tông M150'],
  },
  {
    group: 'Móng',
    code: 'BA+BD+BE',
    name: 'Kết cấu móng BTCT',
    required: true,
    components: ['Bê tông móng', 'Cốt thép móng', 'Ván khuôn móng'],
    notes: 'Mỗi cấu kiện BTCT phải có đủ 3 công tác: bê tông + cốt thép + ván khuôn',
  },
  {
    group: 'Thân',
    code: 'BA+BD+BE',
    name: 'Cột BTCT',
    required: true,
    components: ['Bê tông cột', 'Cốt thép cột', 'Ván khuôn cột'],
  },
  {
    group: 'Thân',
    code: 'BA+BD+BE',
    name: 'Dầm BTCT',
    required: true,
    components: ['Bê tông dầm', 'Cốt thép dầm', 'Ván khuôn dầm'],
  },
  {
    group: 'Thân',
    code: 'BA+BD+BE',
    name: 'Sàn BTCT',
    required: true,
    components: ['Bê tông sàn', 'Cốt thép sàn', 'Ván khuôn sàn'],
  },
  { group: 'Thân', code: 'BF', name: 'Xây tường', required: true, components: ['Xây gạch'] },
  {
    group: 'Hoàn thiện',
    code: 'BG',
    name: 'Trát tường trong/ngoài',
    required: true,
    components: ['Trát trong', 'Trát ngoài'],
  },
  { group: 'Hoàn thiện', code: 'BH', name: 'Lát nền', required: true, components: ['Lát gạch nền'] },
  { group: 'Hoàn thiện', code: 'BL', name: 'Sơn tường', required: true, components: ['Sơn trong', 'Sơn ngoài'] },
  { group: 'Mái', code: 'BM', name: 'Kết cấu mái', required: true, components: ['Lợp mái hoặc bê tông mái'] },
  { group: 'Cửa', code: 'SK', name: 'Lắp đặt cửa', required: true, components: ['Cửa đi', 'Cửa sổ'] },
  {
    group: 'Điện',
    name: 'Hệ thống điện',
    required: true,
    components: ['Điện chiếu sáng', 'Điện ổ cắm'],
    notes: 'MEP cơ bản',
  },
  {
    group: 'Nước',
    name: 'Hệ thống cấp thoát nước',
    required: true,
    components: ['Cấp nước', 'Thoát nước'],
  },
];

export function getChecklistForBuilding(buildingType?: string): WorkItem[] {
  return RESIDENTIAL_CHECKLIST;
}

export function auditAgainstChecklist(
  takeoffNames: string[],
  buildingType?: string,
): { missing: WorkItem[]; covered: WorkItem[] } {
  const checklist = getChecklistForBuilding(buildingType);
  const lNames = takeoffNames.map((n) => n.toLowerCase());

  const covered: WorkItem[] = [];
  const missing: WorkItem[] = [];

  for (const item of checklist) {
    if (!item.required) continue;
    const found = lNames.some(
      (n) =>
        item.name
          .toLowerCase()
          .split(' ')
          .some((w) => w.length > 3 && n.includes(w)) ||
        item.group
          .toLowerCase()
          .split(' ')
          .some((w) => w.length > 3 && n.includes(w)),
    );
    if (found) covered.push(item);
    else missing.push(item);
  }

  return { missing, covered };
}
