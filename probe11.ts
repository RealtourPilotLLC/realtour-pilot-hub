(async()=>{
  const base="https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/FAA_UAS_FacilityMap_Data_V5/FeatureServer";
  const meta = await fetch(`${base}?f=json`).then(r=>r.json()).catch(e=>({err:String(e)}));
  console.log("SERVICE:", JSON.stringify(meta).slice(0,800));
  const l0 = await fetch(`${base}/0?f=json`).then(r=>r.json()).catch(e=>({err:String(e)}));
  console.log("\nLAYER0 name:", (l0 as any).name, "geomType:", (l0 as any).geometryType, "count?:", (l0 as any).error?JSON.stringify((l0 as any).error):"");
  console.log("LAYER0 fields:", ((l0 as any).fields??[]).map((f:any)=>f.name).join(","));
  // count all
  const cnt = await fetch(`${base}/0/query?where=1%3D1&returnCountOnly=true&f=json`).then(r=>r.json());
  console.log("total features:", JSON.stringify(cnt));
  // envelope query around Philly
  const env = await fetch(`${base}/0/query?geometry=${encodeURIComponent("-75.3,39.85,-74.95,40.10")}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&returnCountOnly=true&f=json`).then(r=>r.json());
  console.log("features in Philly bbox:", JSON.stringify(env));
})();
