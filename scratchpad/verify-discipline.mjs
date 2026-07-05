import { detectDiscipline, DISCIPLINES } from '../dist/drawing/discipline.js';

const cases = [
  ['KT.dwg', 'KT'],
  ['KC-01.dwg', 'KC'],
  ['DIEN tang 1.dwg', 'DIEN'],
  ['CTN.dwg', 'NUOC'],
  ['abc.dwg', 'KHAC'],
];

let ok = true;
for (const [name, want] of cases) {
  const got = detectDiscipline(name);
  const pass = got === want;
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} -> ${got} (want ${want})`);
}

const disciplineOk = DISCIPLINES.length === 5;
console.log(`${disciplineOk ? 'PASS' : 'FAIL'}  DISCIPLINES count = ${DISCIPLINES.length} (want 5)`);
console.log('codes:', DISCIPLINES.map((d) => `${d.code}=${d.label}`).join(', '));

if (!ok || !disciplineOk) process.exit(1);
console.log('ALL PASS');
