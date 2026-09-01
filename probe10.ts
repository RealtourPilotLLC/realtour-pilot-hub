const UASFM="https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/FAA_UAS_FacilityMap_Data_V5/FeatureServer/0/query";
async function faa(lat:number,lng:number){
  const params=new URLSearchParams({geometry:`${lng},${lat}`,geometryType:"esriGeometryPoint",inSR:"4326",spatialRel:"esriSpatialRelIntersects",outFields:"CEILING,APT1_NAME,APT1_ICAO,AIRSPACE_1",returnGeometry:"false",f:"json"});
  const t0=Date.now(); const res=await fetch(`${UASFM}?${params}`,{cache:"no-store"}); const j:any=await res.json();
  return {ms:Date.now()-t0, ok:res.ok, status:res.status, features:(j.features??[]).length, err:j.error?JSON.stringify(j.error).slice(0,200):null, first:(j.features??[])[0]?.attributes};
}
async function wx(lat:number,lng:number,atISO:string){
  const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&hourly=temperature_2m,precipitation_probability,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=America%2FNew_York`;
  const t0=Date.now(); const res=await fetch(url); const j:any=await res.json();
  const target=new Date(atISO).toLocaleString("sv-SE",{timeZone:"America/New_York"}).slice(0,13).replace(" ","T")+":00";
  const i=(j.hourly?.time??[]).indexOf(target);
  return {ms:Date.now()-t0, ok:res.ok, target, idx:i, temp:j.hourly?.temperature_2m?.[i], range:[j.hourly?.time?.[0], j.hourly?.time?.slice(-1)[0]]};
}
(async()=>{
  console.log("FAA 626 Greycliffe (drone tomorrow):", JSON.stringify(await faa(40.1902857,-75.2627864)));
  console.log("FAA 617 Westbourne:", JSON.stringify(await faa(39.9344111,-75.5656301)));
  console.log("FAA 2410 E Clementine (Philly):", JSON.stringify(await faa(39.9868732,-75.1074895)));
  console.log("WX 2410 E Clementine today 15:00Z:", JSON.stringify(await wx(39.9868732,-75.1074895,"2026-09-01T15:00:00.000Z")));
  console.log("WX 626 Greycliffe tomorrow 14:00Z:", JSON.stringify(await wx(40.1902857,-75.2627864,"2026-09-02T14:00:00.000Z")));
})();
