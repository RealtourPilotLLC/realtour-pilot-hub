(async()=>{
  const q="https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/FAA_UAS_FacilityMap_Data_V5/FeatureServer/0/query";
  // tiny bbox around 2410 E Clementine St, Philadelphia
  const url=`${q}?geometry=${encodeURIComponent("-75.12,39.97,-75.09,40.00")}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=CEILING,APT1_NAME,AIRSPACE_1,LATITUDE,LONGITUDE&returnGeometry=false&f=json`;
  const j:any=await fetch(url).then(r=>r.json());
  console.log("cells near Clementine:", (j.features??[]).length);
  for (const f of (j.features??[]).slice(0,8)) console.log("  ", JSON.stringify(f.attributes));
  // point query variants
  for (const g of ["-75.1074895,39.9868732", JSON.stringify({x:-75.1074895,y:39.9868732,spatialReference:{wkid:4326}})]) {
    const u=`${q}?geometry=${encodeURIComponent(g)}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=CEILING,APT1_NAME,AIRSPACE_1&returnGeometry=false&f=json`;
    const r:any=await fetch(u).then(r=>r.json());
    console.log("\npoint geom =", g.slice(0,60), "->", (r.features??[]).length, "features", r.error?JSON.stringify(r.error):"", JSON.stringify((r.features??[])[0]?.attributes??{}));
  }
  // known controlled point: right next to PHL airport 39.8729,-75.2437
  for (const [name,lat,lng] of [["PHL airport",39.8729,-75.2437],["Wings Field",40.1375,-75.2650],["Brandywine",39.9900,-75.5817]] as [string,number,number][]) {
    const u=`${q}?geometry=${encodeURIComponent(`${lng},${lat}`)}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=CEILING,APT1_NAME,AIRSPACE_1&returnGeometry=false&f=json`;
    const r:any=await fetch(u).then(r=>r.json());
    console.log(`${name}:`, (r.features??[]).length, JSON.stringify((r.features??[])[0]?.attributes??{}));
  }
})();
