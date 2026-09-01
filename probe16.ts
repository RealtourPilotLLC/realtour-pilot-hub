import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
const prisma = new PrismaClient();
function masterKey(){ return crypto.createHash("sha256").update(process.env.APP_SECRET || "rtp-dev-only-secret-change-me-please-32xx").digest(); }
function dec(blob:string){ const [i,t,d]=blob.split(":"); const c=crypto.createDecipheriv("aes-256-gcm",masterKey(),Buffer.from(i,"hex")); c.setAuthTag(Buffer.from(t,"hex")); return Buffer.concat([c.update(Buffer.from(d,"hex")),c.final()]).toString("utf8"); }
async function main(){
  const conn = await prisma.connection.findUnique({ where:{provider:"dropbox"} });
  if(!conn?.secretEncrypted) return console.log("no dropbox secret");
  const refresh = dec(conn.secretEncrypted);
  const tok:any = await fetch("https://api.dropbox.com/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({refresh_token:refresh,grant_type:"refresh_token",client_id:process.env.DROPBOX_APP_KEY!,client_secret:process.env.DROPBOX_APP_SECRET!})}).then(r=>r.json());
  if(!tok.access_token) return console.log("token fail", JSON.stringify(tok).slice(0,300));
  const token = tok.access_token;
  const acct:any = await fetch("https://api.dropboxapi.com/2/users/get_current_account",{method:"POST",headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json());
  const ns = acct?.root_info?.root_namespace_id ?? null;
  console.log("account:", acct?.email, "root_ns:", ns);
  const hdr:any = { Authorization:`Bearer ${token}`, "Content-Type":"application/json", ...(ns?{"Dropbox-API-Path-Root":JSON.stringify({".tag":"root",root:ns})}:{}) };
  async function list(path:string, recursive=true){
    const t0=Date.now();
    const r = await fetch("https://api.dropboxapi.com/2/files/list_folder",{method:"POST",headers:hdr,body:JSON.stringify({path,recursive})});
    const txt = await r.text(); let j:any; try{j=JSON.parse(txt)}catch{}
    if(!r.ok) return {ok:false,status:r.status,err:(j?.error_summary)??txt.slice(0,150),ms:Date.now()-t0};
    let entries=j.entries??[]; let cur=j.cursor, more=j.has_more, guard=0;
    while(more&&cur&&guard++<50){ const r2=await fetch("https://api.dropboxapi.com/2/files/list_folder/continue",{method:"POST",headers:hdr,body:JSON.stringify({cursor:cur})}); const j2:any=await r2.json(); entries=entries.concat(j2.entries??[]); cur=j2.cursor; more=j2.has_more; }
    return {ok:true, files:entries.filter((e:any)=>e[".tag"]==="file").length, folders:entries.filter((e:any)=>e[".tag"]==="folder").length, ms:Date.now()-t0};
  }
  const targets = await prisma.project.findMany({ where:{ status:{in:["SHOT","EDITING","REVIEW","REVISION"]} }, select:{title:true,status:true,dropboxFolder:true} });
  for (const p of targets){
    if(!p.dropboxFolder){ console.log(`\n${p.status} ${p.title.slice(0,40)} — NO stored folder`); continue; }
    console.log(`\n${p.status} ${p.title.slice(0,40)}  ${p.dropboxFolder}`);
    for (const sub of ["/01-RAW-Photos","/02-RAW-Video","/04-Final-Photos","/05-Final-Video"]) {
      console.log("   ", sub, JSON.stringify(await list(p.dropboxFolder+sub)));
    }
  }
}
main().finally(()=>prisma.$disconnect());
