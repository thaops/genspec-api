const { MongoClient } = require('mongodb');

async function run() {
  const uri = "mongodb+srv://nguyenpham0666_db_user:rIOG1Sr0rwIZrjZ2@cluster0.0p5ql7b.mongodb.net/genspec?appName=Cluster0";
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('genspec');
    const estimatesCol = db.collection('estimates');
    const latest = await estimatesCol.find({}).sort({ updatedAt: -1 }).limit(1).toArray();
    if (!latest.length) {
      console.log("No estimates found");
      return;
    }
    const est = latest[0];
    console.log("Estimate ID:", est._id.toString());
    console.log("Estimate Name:", est.name);
    console.log("Number of sheets:", est.sheets ? est.sheets.length : 0);

    if (est.sheets) {
      for (const sheet of est.sheets) {
        const hasStyles = sheet.data?._styles ? Object.keys(sheet.data._styles).length : 0;
        const cellData = sheet.data?.cellData || {};
        let stringStyles = [];
        let objectStyles = [];
        for (const [r, cols] of Object.entries(cellData)) {
          for (const [c, cell] of Object.entries(cols)) {
            if (cell && cell.s) {
              if (typeof cell.s === 'string') {
                stringStyles.push({ r, c, s: cell.s });
              } else {
                objectStyles.push({ r, c, s: cell.s });
              }
            }
          }
        }
        console.log(`Sheet "${sheet.name}" (${sheet.id}):`);
        console.log(`  _styles keys:`, hasStyles);
        console.log(`  String styles count:`, stringStyles.length, `(examples: ${JSON.stringify(stringStyles.slice(0, 5))})`);
        console.log(`  Object styles count:`, objectStyles.length, `(examples: ${JSON.stringify(objectStyles.slice(0, 5))})`);
      }
    }
  } finally {
    await client.close();
  }
}

run().catch(console.error);
