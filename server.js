@@ -1,83 +1,129 @@
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import { startBaileys } from "./baileys.js";
import { jidNormalizedUser } from "@whiskeysockets/baileys";

const app = express();
app.use(bodyParser.json());

// Variables de entorno
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const API_KEY = process.env.API_KEY || "";

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ["GET","POST","DELETE"],
  allowedHeaders: ["Content-Type","x-api-key"]
}));

app.use((req,res,next)=>{
  if(req.method=="POST"||req.method=="DELETE"){
    const key=req.headers["x-api-key"];
    if(!API_KEY or key==API_KEY) return next();
    return res.status(401).json({error:"Invalid API key"});
// Configuración de CORS
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// Middleware para validar API_KEY en POST/DELETE
app.use((req, res, next) => {
  if (req.method === "POST" || req.method === "DELETE") {
    const key = req.headers["x-api-key"];
    if (!API_KEY || key === API_KEY) return next();
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
});

const sessions=new Map();
function authDir(sessionId){ return path.join("./auth",sessionId); }

app.get("/",(_,res)=>res.json({ok:true,service:"baileys-microservice"}));

app.post("/sessions",async(req,res)=>{
  try{
    const {sessionId}=req.body||{};
    if(!sessionId) return res.status(400).json({error:"Missing sessionId"});
    fs.mkdirSync(authDir(sessionId),{recursive:true});
    const state={sock:null,lastQrDataUrl:null};
    sessions.set(sessionId,state);
    const sock=await startBaileys(
      async qr=>{state.lastQrDataUrl=await QRCode.toDataURL(qr);},
      s=>{state.sock=s;},
// Manejador de sesiones
const sessions = new Map();
function authDir(sessionId) {
  return path.join("./auth", sessionId);
}

// Endpoint base (prueba de vida)
app.get("/", (_, res) =>
  res.json({ ok: true, service: "baileys-microservice" })
);

// Crear una nueva sesión
app.post("/sessions", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId)
      return res.status(400).json({ error: "Missing sessionId" });

    fs.mkdirSync(authDir(sessionId), { recursive: true });
    const state = { sock: null, lastQrDataUrl: null };
    sessions.set(sessionId, state);

    const sock = await startBaileys(
      async (qr) => {
        state.lastQrDataUrl = await QRCode.toDataURL(qr);
      },
      (s) => {
        state.sock = s;
      },
      authDir(sessionId)
    );
    state.sock=sock;
    return res.json({ok:true,sessionId});
  }catch(e){return res.status(500).json({error:String(e?.message||e)});}

    state.sock = sock;
    return res.json({ ok: true, sessionId });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/sessions/:id/status",(req,res)=>{
  const s=sessions.get(req.params.id);
  if(!s) return res.json({connected:false});
  const connected=!!(s.sock&&s.sock.user);
  return res.json({connected,me:s.sock?.user||null});
// Ver estado de una sesión
app.get("/sessions/:id/status", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ connected: false });
  const connected = !!(s.sock && s.sock.user);
  return res.json({ connected, me: s.sock?.user || null });
});

app.get("/sessions/:id/qr.png",(req,res)=>{
  const s=sessions.get(req.params.id);
  if(!s||!s.lastQrDataUrl) return res.status(404).send("QR not ready");
  const base64=s.lastQrDataUrl.split(",")[1];
  res.setHeader("Content-Type","image/png");
  res.send(Buffer.from(base64,"base64"));
// Obtener QR en PNG
app.get("/sessions/:id/qr.png", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.lastQrDataUrl) return res.status(404).send("QR not ready");
  const base64 = s.lastQrDataUrl.split(",")[1];
  res.setHeader("Content-Type", "image/png");
  res.send(Buffer.from(base64, "base64"));
});

// Enviar mensaje desde una sesión
app.post("/sessions/:id/send", async (req, res) => {
  try {
    const s = sessions.get(req.params.id);
    if (!s || !s.sock)
      return res.status(400).json({ error: "Session not found" });
    if (!s.sock.user)
      return res.status(400).json({ error: "Not connected" });

    let { to, text } = req.body || {};
    if (!to || !text)
      return res.status(400).json({ error: "Missing 'to' or 'text'" });

    if (!to.includes("@")) to = `${to}@s.whatsapp.net`;
    const jid = jidNormalizedUser(to);

    const r = await s.sock.sendMessage(jid, { text });
    return res.json({ ok: true, id: r?.key?.id || null });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/sessions/:id/send",async(req,res)=>{
  try{
    const s=sessions.get(req.params.id);
    if(!s||!s.sock) return res.status(400).json({error:"Session not found"});
    if(!s.sock.user) return res.status(400).json({error:"Not connected"});
    let {to,text}=req.body||{};
    if(!to||!text) return res.status(400).json({error:"Missing to/text"});
    if(!to.includes("@")) to=`${to}@s.whatsapp.net`;
    const jid=jidNormalizedUser(to);
    const r=await s.sock.sendMessage(jid,{text});
    return res.json({ok:true,id:r?.key?.id||null});
  }catch(e){return res.status(500).json({error:String(e?.message||e)});}
// Eliminar una sesión
app.delete("/sessions/:id", (req, res) => {
  const id = req.params.id;
  sessions.delete(id);
  try {
    fs.rmSync(authDir(id), { recursive: true, force: true });
  } catch {}
  return res.json({ ok: true });
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log("Baileys microservice running on",PORT));
// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("Baileys microservice running on", PORT)
);
