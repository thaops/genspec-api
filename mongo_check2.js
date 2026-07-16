const fs = require('fs');
const env = fs.readFileSync('.env', 'utf-8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const mongoose = require('mongoose');
(async()=>{
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const dId = '6a5832bf33d71a0fe35c1ebd';
  const agg = await db.collection('drawingobjects').aggregate([
    { $match: { drawingId: dId } },
    { $group: { _id: '$type', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]).toArray();
  console.log('type distribution:', agg);
  const total = await db.collection('drawingobjects').countDocuments({ drawingId: dId });
  console.log('total objects:', total);
  const drawing = await db.collection('drawings').findOne({ _id: new mongoose.Types.ObjectId(dId) });
  console.log('unitFactor:', drawing.unitFactor, 'pageCount:', drawing.pageCount);
})().catch(e=>{console.error('ERR', e.message); process.exit(1);});
