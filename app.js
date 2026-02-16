console.log("maintenance app.js loaded");

// ====== CONFIG ======
const SUPABASE_URL = "https://hfyvjtaumvmaqeqkmiyk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhmeXZqdGF1bXZtYXFlcWttaXlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyNDgxNTksImV4cCI6MjA4NjgyNDE1OX0.hPMNVRMJClpqbXzV8Ug06K-KHQHdfoUhLKlos66q6do";

const YELLOW_AFTER_MIN = 5;
const RED_AFTER_MIN = 10;

// ====== INIT ======
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById("app");
const route = location.hash || "#maintenance";

// ====== TIME HELPERS ======
function parseTs(ts){
  if (!ts) return null;
  let s = String(ts).trim();
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  const hasTZ = /Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s);
  if (!hasTZ) s += "Z";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatSec(sec){
  if (sec == null) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.max(0, sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function urgencyClass(sec){
  if (sec == null) return "";
  if (sec >= RED_AFTER_MIN*60) return "uRed";
  if (sec >= YELLOW_AFTER_MIN*60) return "uYellow";
  return "uGreen";
}

// Freeze timer when done/confirmed (duration_sec stored when DONE)
function calcSeconds(t){
  const startD = parseTs(t?.created_at);
  if (!startD) return null;
  const start = startD.getTime();

  // stored duration (frozen)
  if (t.duration_sec != null && Number.isFinite(Number(t.duration_sec))) {
    return Number(t.duration_sec);
  }

  const st = String(t.status || "").toUpperCase();

  // stop time preference: confirmed > done
  let stopD = null;
  if ((st === "CONFIRMED" || st === "REOPENED") && t.confirmed_at) stopD = parseTs(t.confirmed_at);
  if (!stopD && (st === "DONE" || st === "CONFIRMED" || st === "REOPENED") && t.done_at) stopD = parseTs(t.done_at);

  if (stopD) return Math.max(0, Math.floor((stopD.getTime() - start)/1000));
  return Math.max(0, Math.floor((Date.now() - start)/1000));
}

// ====== ROUTES ======
// #line/L1   -> operator
// #maintenance -> maintenance board
// #monitor -> monitor
if (route.startsWith("#line/")) loadLine(route.split("/")[1]);
else if (route.startsWith("#monitor")) loadMonitor();
else loadMaintenance();

// ====== OPERATOR (LINE) ======
async function loadLine(line){
  app.innerHTML = `
    <div class="header">LINE ${line} — Maintenance Call</div>

    <div class="topbar">
      <a class="btn" href="#maintenance">Maintenance</a>
      <a class="btn" href="#monitor">Monitor</a>
      <div style="opacity:.8;">Yellow ≥ ${YELLOW_AFTER_MIN}min | Red ≥ ${RED_AFTER_MIN}min</div>
    </div>

    <div style="padding:12px;">
      <div style="font-weight:900;margin-bottom:8px;">Choose station</div>
      <div id="stations" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;"></div>

      <div style="height:14px;"></div>

      <div style="font-weight:900;margin-bottom:8px;">My tickets (latest)</div>
      <div id="myTickets" style="display:grid;gap:10px;"></div>
    </div>
  `;

  const stationsEl = document.getElementById("stations");
  const myEl = document.getElementById("myTickets");

  // load stations for line
  const { data: stations, error: stErr } = await sb
    .from("stations")
    .select("*")
    .eq("line", line)
    .eq("is_active", true)
    .order("sort", { ascending:true });

  if (stErr) console.error(stErr);

  (stations || []).forEach(s => {
    const btn = document.createElement("button");
    btn.className = "btn btnBlue";
    btn.style.textAlign = "left";
    btn.innerHTML = `<div style="font-weight:1000;font-size:18px;">${s.station}</div><div style="opacity:.8;font-size:12px;">Tap to create ticket</div>`;
    btn.onclick = () => openCreateTicketModal(line, s.station);
    stationsEl.appendChild(btn);
  });

  async function refreshMy(){
    const { data, error } = await sb
      .from("tickets")
      .select("*")
      .eq("line", line)
      .order("created_at", { ascending:false })
      .limit(30);

    if (error) console.error(error);

    myEl.innerHTML = "";
    (data || []).forEach(t => {
      const sec = calcSeconds(t);
      const card = document.createElement("div");
      card.className = `card ${urgencyClass(sec)}`;

      card.innerHTML = `
        <div class="cardTop">
          <div class="pill">${t.station}</div>
          <div class="timeBig">${formatSec(sec)}</div>
        </div>
        <div class="title">${t.priority} — ${t.status}</div>
        <div class="desc">${t.description || ""}</div>
        ${t.maint_comment ? `<div class="meta"><span style="opacity:.7;">Maint</span><span>${t.maint_comment}</span></div>` : ""}
        ${t.operator_comment ? `<div class="meta"><span style="opacity:.7;">Operator</span><span>${t.operator_comment}</span></div>` : ""}
        <div class="actions" id="opBtns-${t.id}"></div>
      `;

      const btnBox = card.querySelector(`#opBtns-${t.id}`);

      const st = String(t.status||"").toUpperCase();
      if (st === "DONE") {
        const ok = document.createElement("button");
        ok.className = "btnGreen";
        ok.textContent = "CONFIRM";
        ok.onclick = async () => {
          const { error } = await sb.from("tickets").update({
            status: "CONFIRMED",
            confirmed_at: new Date().toISOString()
          }).eq("id", t.id);
          if (error) console.error(error);
        };

        const reopen = document.createElement("button");
        reopen.className = "btnRed";
        reopen.textContent = "NOT FIXED";
        reopen.onclick = async () => {
          const reason = prompt("Short reason (optional):", "Still not working");
          const { error } = await sb.from("tickets").update({
            status: "REOPENED",
            confirmed_at: new Date().toISOString(),
            operator_comment: reason || null,
            duration_sec: null,     // re-open: unfreeze timer again
            done_at: null           // optional: clear done timestamp so it becomes active again
          }).eq("id", t.id);
          if (error) console.error(error);
        };

        btnBox.appendChild(ok);
        btnBox.appendChild(reopen);
      } else {
        btnBox.innerHTML = `<div style="opacity:.7;">Waiting for maintenance / in progress…</div>`;
      }

      myEl.appendChild(card);
    });
  }

  function openCreateTicketModal(line, station){
    const wrap = document.createElement("div");
    wrap.style.position="fixed";
    wrap.style.inset="0";
    wrap.style.background="rgba(0,0,0,.7)";
    wrap.style.display="grid";
    wrap.style.placeItems="center";
    wrap.style.zIndex="9999";

    wrap.innerHTML = `
      <div class="card" style="width:min(560px,92vw);">
        <div style="font-weight:1000;font-size:20px;">New ticket — ${line} / ${station}</div>
        <div style="height:10px;"></div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <select id="prio" class="select" style="min-width:160px;">
            <option value="LOW">LOW</option>
            <option value="MED" selected>MED</option>
            <option value="HIGH">HIGH</option>
          </select>

          <input id="issue" class="input" placeholder="Issue type (optional)" style="flex:1;min-width:180px;" />
        </div>

        <div style="height:10px;"></div>
        <textarea id="desc" placeholder="Describe problem… (required)"></textarea>

        <div style="height:10px;"></div>
        <div style="display:flex;gap:10px;">
          <button id="cancel" class="btn">Cancel</button>
          <button id="send" class="btn btnBlue" style="flex:1;">SEND</button>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    wrap.querySelector("#cancel").onclick = () => wrap.remove();

    wrap.querySelector("#send").onclick = async () => {
      const prio = wrap.querySelector("#prio").value;
      const issue = wrap.querySelector("#issue").value.trim();
      const desc = wrap.querySelector("#desc").value.trim();

      if (!desc) { alert("Description required."); return; }

      const { error } = await sb.from("tickets").insert({
        line,
        station,
        priority: prio,
        issue_type: issue || null,
        description: desc,
        status: "NEW",
        created_at: new Date().toISOString()
      });

      if (error) {
        console.error(error);
        alert("Failed to create ticket");
      } else {
        wrap.remove();
      }
    };
  }

  refreshMy();

  sb.channel(`line_${line}_tickets`)
    .on("postgres_changes", { event:"*", schema:"public", table:"tickets" }, (payload) => {
      if (payload.new?.line === line || payload.old?.line === line) refreshMy();
    })
    .subscribe();

  setInterval(refreshMy, 2000);
}

// ====== MAINTENANCE BOARD ======
async function loadMaintenance(){
  const state = { q:"", line:"ALL", daysBack:1 };

  app.innerHTML = `
    <div class="header">MAINTENANCE</div>

    <div class="topbar">
      <input id="search" class="input" placeholder="Search station/desc..." />
      <select id="lineFilter" class="select">
        <option value="ALL">All lines</option>
        ${Array.from({length:9},(_,i)=>`<option value="L${i+1}">L${i+1}</option>`).join("")}
      </select>
      <select id="rangeFilter" class="select">
        <option value="1">Today</option>
        <option value="7">7 days</option>
        <option value="30">30 days</option>
      </select>

      <a class="btn" href="#monitor">Monitor</a>
    </div>

    <div class="board">
      <div class="col">
        <div class="colHead"><div class="colTitle">NEW</div><div class="colCount" id="countNEW">0</div></div>
        <div class="colBody" id="colNEW"></div>
      </div>
      <div class="col">
        <div class="colHead"><div class="colTitle">TAKEN</div><div class="colCount" id="countTAKEN">0</div></div>
        <div class="colBody" id="colTAKEN"></div>
      </div>
      <div class="col">
        <div class="colHead"><div class="colTitle">DONE</div><div class="colCount" id="countDONE">0</div></div>
        <div class="colBody" id="colDONE"></div>
      </div>
    </div>
  `;

  const searchEl = document.getElementById("search");
  const lineEl   = document.getElementById("lineFilter");
  const rangeEl  = document.getElementById("rangeFilter");

  const colNEW = document.getElementById("colNEW");
  const colTAK = document.getElementById("colTAKEN");
  const colDON = document.getElementById("colDONE");

  const countNEW = document.getElementById("countNEW");
  const countTAK = document.getElementById("countTAKEN");
  const countDON = document.getElementById("countDONE");

  function readState(){
    state.q = (searchEl.value || "").trim().toLowerCase();
    state.line = lineEl.value || "ALL";
    state.daysBack = Number(rangeEl.value || 1);
  }

  function makeCard(t){
    const sec = calcSeconds(t);
    const card = document.createElement("div");
    card.className = `card ${urgencyClass(sec)}`;

    card.innerHTML = `
      <div class="cardTop">
        <div class="pill">${t.line}</div>
        <div class="timeBig">${formatSec(sec)}</div>
      </div>
      <div class="title">${t.station} — ${t.priority}</div>
      <div class="desc">${t.description || ""}</div>
      <div class="meta">
        <div style="opacity:.75;">${t.status}</div>
        <div style="opacity:.75;">${t.issue_type || ""}</div>
      </div>
      <div class="actions" id="btns-${t.id}"></div>
    `;

    const btns = card.querySelector(`#btns-${t.id}`);
    const st = String(t.status||"").toUpperCase();

    const takeBtn = document.createElement("button");
    takeBtn.textContent = "TAKE";
    takeBtn.style.background = "#2b7cff";
    takeBtn.style.color = "#fff";
    takeBtn.disabled = (st !== "NEW");
    takeBtn.onclick = async () => {
      const name = prompt("Your name (optional):", "");
      const { error } = await sb.from("tickets").update({
        status:"TAKEN",
        taken_at: new Date().toISOString(),
        taken_by: name || null
      }).eq("id", t.id);
      if (error) console.error(error);
    };

    const doneBtn = document.createElement("button");
    doneBtn.textContent = "DONE";
    doneBtn.style.background = "#4caf50";
    doneBtn.style.color = "#fff";
    doneBtn.disabled = (st !== "TAKEN" && st !== "REOPENED");
    doneBtn.onclick = async () => {
      const comment = prompt("Short fix comment (required):", "Fixed / adjusted / replaced…");
      if (!comment || !comment.trim()) { alert("Comment required."); return; }

      // compute duration now (freeze)
      const start = parseTs(t.created_at)?.getTime();
      const now = Date.now();
      const duration = start ? Math.max(0, Math.floor((now - start)/1000)) : null;

      const { error } = await sb.from("tickets").update({
        status:"DONE",
        done_at: new Date(now).toISOString(),
        maint_comment: comment.trim(),
        duration_sec: duration
      }).eq("id", t.id);
      if (error) console.error(error);
    };

    btns.appendChild(takeBtn);
    btns.appendChild(doneBtn);

    return card;
  }

  async function render(){
    readState();
    const since = new Date(Date.now() - state.daysBack*24*60*60*1000).toISOString();

    let q = sb
      .from("tickets")
      .select("*")
      .gte("created_at", since)
      .in("status", ["NEW","TAKEN","DONE","REOPENED"])
      .order("created_at", { ascending:true });

    if (state.line !== "ALL") q = q.eq("line", state.line);

    const { data, error } = await q;
    if (error) { console.error(error); return; }

    let rows = data || [];

    if (state.q) {
      const needle = state.q;
      rows = rows.filter(t =>
        String(t.station||"").toLowerCase().includes(needle) ||
        String(t.description||"").toLowerCase().includes(needle)
      );
    }

    // treat REOPENED as NEW bucket (open)
    const by = { NEW:[], TAKEN:[], DONE:[] };
    rows.forEach(t => {
      const st = String(t.status||"").toUpperCase();
      if (st === "TAKEN") by.TAKEN.push(t);
      else if (st === "DONE") by.DONE.push(t);
      else by.NEW.push(t); // NEW or REOPENED
    });

    // sort by longest waiting first
    ["NEW","TAKEN","DONE"].forEach(k => by[k].sort((a,b)=>(calcSeconds(b)||0)-(calcSeconds(a)||0)));

    colNEW.innerHTML = ""; colTAK.innerHTML = ""; colDON.innerHTML = "";
    by.NEW.forEach(t => colNEW.appendChild(makeCard(t)));
    by.TAKEN.forEach(t => colTAK.appendChild(makeCard(t)));
    by.DONE.forEach(t => colDON.appendChild(makeCard(t)));

    countNEW.textContent = by.NEW.length;
    countTAK.textContent = by.TAKEN.length;
    countDON.textContent = by.DONE.length;
  }

  render();

  sb.channel("tickets_maintenance")
    .on("postgres_changes", {event:"*", schema:"public", table:"tickets"}, render)
    .subscribe();

  searchEl.addEventListener("input", render);
  lineEl.addEventListener("change", render);
  rangeEl.addEventListener("change", render);

  setInterval(render, 2000);
}

// ====== MONITOR ======
async function loadMonitor(){
  app.innerHTML = `
    <div class="header">MONITOR</div>
    <div class="topbar">
      <a class="btn" href="#maintenance">Maintenance</a>
      <a class="btn" href="#line/L1">Line L1</a>
      <div style="opacity:.8;">Yellow ≥ ${YELLOW_AFTER_MIN}min | Red ≥ ${RED_AFTER_MIN}min</div>
    </div>
    <div style="padding:12px;" id="rows"></div>
  `;

  const rowsEl = document.getElementById("rows");

  async function render(){
    const since = new Date(Date.now() - 7*24*60*60*1000).toISOString();

    const { data, error } = await sb
      .from("tickets")
      .select("*")
      .gte("created_at", since)
      .neq("status","CONFIRMED")
      .order("created_at", { ascending:true });

    if (error) { console.error(error); return; }

    const items = (data || [])
      .map(t => ({ t, sec: calcSeconds(t) }))
      .sort((a,b)=>(b.sec||0)-(a.sec||0));

    rowsEl.innerHTML = "";
    items.forEach(({t, sec}) => {
      const card = document.createElement("div");
      card.className = `card ${urgencyClass(sec)}`;
      card.innerHTML = `
        <div class="cardTop">
          <div class="pill">${t.line}</div>
          <div class="timeBig">${formatSec(sec)}</div>
        </div>
        <div class="title">${t.station} — ${t.status}</div>
        <div class="desc">${t.description || ""}</div>
        ${t.maint_comment ? `<div class="meta"><span style="opacity:.7;">Maint</span><span>${t.maint_comment}</span></div>` : ""}
      `;
      rowsEl.appendChild(card);
    });
  }

  render();

  sb.channel("tickets_monitor")
    .on("postgres_changes", {event:"*", schema:"public", table:"tickets"}, render)
    .subscribe();

  setInterval(render, 2000);
}
console.log("maintenance app.js loaded");

// ====== CONFIG ======
const SUPABASE_URL = "https://xopxxznvaorhvqucamve.supabase.co";
const SUPABASE_KEY = "YOUR_ANON_KEY_HERE";

const YELLOW_AFTER_MIN = 5;
const RED_AFTER_MIN = 10;

// ====== INIT ======
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById("app");
const route = location.hash || "#maintenance";

// ====== TIME HELPERS ======
function parseTs(ts){
  if (!ts) return null;
  let s = String(ts).trim();
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  const hasTZ = /Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s);
  if (!hasTZ) s += "Z";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatSec(sec){
  if (sec == null) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.max(0, sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function urgencyClass(sec){
  if (sec == null) return "";
  if (sec >= RED_AFTER_MIN*60) return "uRed";
  if (sec >= YELLOW_AFTER_MIN*60) return "uYellow";
  return "uGreen";
}

// Freeze timer when done/confirmed (duration_sec stored when DONE)
function calcSeconds(t){
  const startD = parseTs(t?.created_at);
  if (!startD) return null;
  const start = startD.getTime();

  // stored duration (frozen)
  if (t.duration_sec != null && Number.isFinite(Number(t.duration_sec))) {
    return Number(t.duration_sec);
  }

  const st = String(t.status || "").toUpperCase();

  // stop time preference: confirmed > done
  let stopD = null;
  if ((st === "CONFIRMED" || st === "REOPENED") && t.confirmed_at) stopD = parseTs(t.confirmed_at);
  if (!stopD && (st === "DONE" || st === "CONFIRMED" || st === "REOPENED") && t.done_at) stopD = parseTs(t.done_at);

  if (stopD) return Math.max(0, Math.floor((stopD.getTime() - start)/1000));
  return Math.max(0, Math.floor((Date.now() - start)/1000));
}

// ====== ROUTES ======
// #line/L1   -> operator
// #maintenance -> maintenance board
// #monitor -> monitor
if (route.startsWith("#line/")) loadLine(route.split("/")[1]);
else if (route.startsWith("#monitor")) loadMonitor();
else loadMaintenance();

// ====== OPERATOR (LINE) ======
async function loadLine(line){
  app.innerHTML = `
    <div class="header">LINE ${line} — Maintenance Call</div>

    <div class="topbar">
      <a class="btn" href="#maintenance">Maintenance</a>
      <a class="btn" href="#monitor">Monitor</a>
      <div style="opacity:.8;">Yellow ≥ ${YELLOW_AFTER_MIN}min | Red ≥ ${RED_AFTER_MIN}min</div>
    </div>

    <div style="padding:12px;">
      <div style="font-weight:900;margin-bottom:8px;">Choose station</div>
      <div id="stations" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;"></div>

      <div style="height:14px;"></div>

      <div style="font-weight:900;margin-bottom:8px;">My tickets (latest)</div>
      <div id="myTickets" style="display:grid;gap:10px;"></div>
    </div>
  `;

  const stationsEl = document.getElementById("stations");
  const myEl = document.getElementById("myTickets");

  // load stations for line
  const { data: stations, error: stErr } = await sb
    .from("stations")
    .select("*")
    .eq("line", line)
    .eq("is_active", true)
    .order("sort", { ascending:true });

  if (stErr) console.error(stErr);

  (stations || []).forEach(s => {
    const btn = document.createElement("button");
    btn.className = "btn btnBlue";
    btn.style.textAlign = "left";
    btn.innerHTML = `<div style="font-weight:1000;font-size:18px;">${s.station}</div><div style="opacity:.8;font-size:12px;">Tap to create ticket</div>`;
    btn.onclick = () => openCreateTicketModal(line, s.station);
    stationsEl.appendChild(btn);
  });

  async function refreshMy(){
    const { data, error } = await sb
      .from("tickets")
      .select("*")
      .eq("line", line)
      .order("created_at", { ascending:false })
      .limit(30);

    if (error) console.error(error);

    myEl.innerHTML = "";
    (data || []).forEach(t => {
      const sec = calcSeconds(t);
      const card = document.createElement("div");
      card.className = `card ${urgencyClass(sec)}`;

      card.innerHTML = `
        <div class="cardTop">
          <div class="pill">${t.station}</div>
          <div class="timeBig">${formatSec(sec)}</div>
        </div>
        <div class="title">${t.priority} — ${t.status}</div>
        <div class="desc">${t.description || ""}</div>
        ${t.maint_comment ? `<div class="meta"><span style="opacity:.7;">Maint</span><span>${t.maint_comment}</span></div>` : ""}
        ${t.operator_comment ? `<div class="meta"><span style="opacity:.7;">Operator</span><span>${t.operator_comment}</span></div>` : ""}
        <div class="actions" id="opBtns-${t.id}"></div>
      `;

      const btnBox = card.querySelector(`#opBtns-${t.id}`);

      const st = String(t.status||"").toUpperCase();
      if (st === "DONE") {
        const ok = document.createElement("button");
        ok.className = "btnGreen";
        ok.textContent = "CONFIRM";
        ok.onclick = async () => {
          const { error } = await sb.from("tickets").update({
            status: "CONFIRMED",
            confirmed_at: new Date().toISOString()
          }).eq("id", t.id);
          if (error) console.error(error);
        };

        const reopen = document.createElement("button");
        reopen.className = "btnRed";
        reopen.textContent = "NOT FIXED";
        reopen.onclick = async () => {
          const reason = prompt("Short reason (optional):", "Still not working");
          const { error } = await sb.from("tickets").update({
            status: "REOPENED",
            confirmed_at: new Date().toISOString(),
            operator_comment: reason || null,
            duration_sec: null,     // re-open: unfreeze timer again
            done_at: null           // optional: clear done timestamp so it becomes active again
          }).eq("id", t.id);
          if (error) console.error(error);
        };

        btnBox.appendChild(ok);
        btnBox.appendChild(reopen);
      } else {
        btnBox.innerHTML = `<div style="opacity:.7;">Waiting for maintenance / in progress…</div>`;
      }

      myEl.appendChild(card);
    });
  }

  function openCreateTicketModal(line, station){
    const wrap = document.createElement("div");
    wrap.style.position="fixed";
    wrap.style.inset="0";
    wrap.style.background="rgba(0,0,0,.7)";
    wrap.style.display="grid";
    wrap.style.placeItems="center";
    wrap.style.zIndex="9999";

    wrap.innerHTML = `
      <div class="card" style="width:min(560px,92vw);">
        <div style="font-weight:1000;font-size:20px;">New ticket — ${line} / ${station}</div>
        <div style="height:10px;"></div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <select id="prio" class="select" style="min-width:160px;">
            <option value="LOW">LOW</option>
            <option value="MED" selected>MED</option>
            <option value="HIGH">HIGH</option>
          </select>

          <input id="issue" class="input" placeholder="Issue type (optional)" style="flex:1;min-width:180px;" />
        </div>

        <div style="height:10px;"></div>
        <textarea id="desc" placeholder="Describe problem… (required)"></textarea>

        <div style="height:10px;"></div>
        <div style="display:flex;gap:10px;">
          <button id="cancel" class="btn">Cancel</button>
          <button id="send" class="btn btnBlue" style="flex:1;">SEND</button>
        </div>
      </div>
    `;

    document.body.appendChild(wrap);

    wrap.querySelector("#cancel").onclick = () => wrap.remove();

    wrap.querySelector("#send").onclick = async () => {
      const prio = wrap.querySelector("#prio").value;
      const issue = wrap.querySelector("#issue").value.trim();
      const desc = wrap.querySelector("#desc").value.trim();

      if (!desc) { alert("Description required."); return; }

      const { error } = await sb.from("tickets").insert({
        line,
        station,
        priority: prio,
        issue_type: issue || null,
        description: desc,
        status: "NEW",
        created_at: new Date().toISOString()
      });

      if (error) {
        console.error(error);
        alert("Failed to create ticket");
      } else {
        wrap.remove();
      }
    };
  }

  refreshMy();

  sb.channel(`line_${line}_tickets`)
    .on("postgres_changes", { event:"*", schema:"public", table:"tickets" }, (payload) => {
      if (payload.new?.line === line || payload.old?.line === line) refreshMy();
    })
    .subscribe();

  setInterval(refreshMy, 2000);
}

// ====== MAINTENANCE BOARD ======
async function loadMaintenance(){
  const state = { q:"", line:"ALL", daysBack:1 };

  app.innerHTML = `
    <div class="header">MAINTENANCE</div>

    <div class="topbar">
      <input id="search" class="input" placeholder="Search station/desc..." />
      <select id="lineFilter" class="select">
        <option value="ALL">All lines</option>
        ${Array.from({length:9},(_,i)=>`<option value="L${i+1}">L${i+1}</option>`).join("")}
      </select>
      <select id="rangeFilter" class="select">
        <option value="1">Today</option>
        <option value="7">7 days</option>
        <option value="30">30 days</option>
      </select>

      <a class="btn" href="#monitor">Monitor</a>
    </div>

    <div class="board">
      <div class="col">
        <div class="colHead"><div class="colTitle">NEW</div><div class="colCount" id="countNEW">0</div></div>
        <div class="colBody" id="colNEW"></div>
      </div>
      <div class="col">
        <div class="colHead"><div class="colTitle">TAKEN</div><div class="colCount" id="countTAKEN">0</div></div>
        <div class="colBody" id="colTAKEN"></div>
      </div>
      <div class="col">
        <div class="colHead"><div class="colTitle">DONE</div><div class="colCount" id="countDONE">0</div></div>
        <div class="colBody" id="colDONE"></div>
      </div>
    </div>
  `;

  const searchEl = document.getElementById("search");
  const lineEl   = document.getElementById("lineFilter");
  const rangeEl  = document.getElementById("rangeFilter");

  const colNEW = document.getElementById("colNEW");
  const colTAK = document.getElementById("colTAKEN");
  const colDON = document.getElementById("colDONE");

  const countNEW = document.getElementById("countNEW");
  const countTAK = document.getElementById("countTAKEN");
  const countDON = document.getElementById("countDONE");

  function readState(){
    state.q = (searchEl.value || "").trim().toLowerCase();
    state.line = lineEl.value || "ALL";
    state.daysBack = Number(rangeEl.value || 1);
  }

  function makeCard(t){
    const sec = calcSeconds(t);
    const card = document.createElement("div");
    card.className = `card ${urgencyClass(sec)}`;

    card.innerHTML = `
      <div class="cardTop">
        <div class="pill">${t.line}</div>
        <div class="timeBig">${formatSec(sec)}</div>
      </div>
      <div class="title">${t.station} — ${t.priority}</div>
      <div class="desc">${t.description || ""}</div>
      <div class="meta">
        <div style="opacity:.75;">${t.status}</div>
        <div style="opacity:.75;">${t.issue_type || ""}</div>
      </div>
      <div class="actions" id="btns-${t.id}"></div>
    `;

    const btns = card.querySelector(`#btns-${t.id}`);
    const st = String(t.status||"").toUpperCase();

    const takeBtn = document.createElement("button");
    takeBtn.textContent = "TAKE";
    takeBtn.style.background = "#2b7cff";
    takeBtn.style.color = "#fff";
    takeBtn.disabled = (st !== "NEW");
    takeBtn.onclick = async () => {
      const name = prompt("Your name (optional):", "");
      const { error } = await sb.from("tickets").update({
        status:"TAKEN",
        taken_at: new Date().toISOString(),
        taken_by: name || null
      }).eq("id", t.id);
      if (error) console.error(error);
    };

    const doneBtn = document.createElement("button");
    doneBtn.textContent = "DONE";
    doneBtn.style.background = "#4caf50";
    doneBtn.style.color = "#fff";
    doneBtn.disabled = (st !== "TAKEN" && st !== "REOPENED");
    doneBtn.onclick = async () => {
      const comment = prompt("Short fix comment (required):", "Fixed / adjusted / replaced…");
      if (!comment || !comment.trim()) { alert("Comment required."); return; }

      // compute duration now (freeze)
      const start = parseTs(t.created_at)?.getTime();
      const now = Date.now();
      const duration = start ? Math.max(0, Math.floor((now - start)/1000)) : null;

      const { error } = await sb.from("tickets").update({
        status:"DONE",
        done_at: new Date(now).toISOString(),
        maint_comment: comment.trim(),
        duration_sec: duration
      }).eq("id", t.id);
      if (error) console.error(error);
    };

    btns.appendChild(takeBtn);
    btns.appendChild(doneBtn);

    return card;
  }

  async function render(){
    readState();
    const since = new Date(Date.now() - state.daysBack*24*60*60*1000).toISOString();

    let q = sb
      .from("tickets")
      .select("*")
      .gte("created_at", since)
      .in("status", ["NEW","TAKEN","DONE","REOPENED"])
      .order("created_at", { ascending:true });

    if (state.line !== "ALL") q = q.eq("line", state.line);

    const { data, error } = await q;
    if (error) { console.error(error); return; }

    let rows = data || [];

    if (state.q) {
      const needle = state.q;
      rows = rows.filter(t =>
        String(t.station||"").toLowerCase().includes(needle) ||
        String(t.description||"").toLowerCase().includes(needle)
      );
    }

    // treat REOPENED as NEW bucket (open)
    const by = { NEW:[], TAKEN:[], DONE:[] };
    rows.forEach(t => {
      const st = String(t.status||"").toUpperCase();
      if (st === "TAKEN") by.TAKEN.push(t);
      else if (st === "DONE") by.DONE.push(t);
      else by.NEW.push(t); // NEW or REOPENED
    });

    // sort by longest waiting first
    ["NEW","TAKEN","DONE"].forEach(k => by[k].sort((a,b)=>(calcSeconds(b)||0)-(calcSeconds(a)||0)));

    colNEW.innerHTML = ""; colTAK.innerHTML = ""; colDON.innerHTML = "";
    by.NEW.forEach(t => colNEW.appendChild(makeCard(t)));
    by.TAKEN.forEach(t => colTAK.appendChild(makeCard(t)));
    by.DONE.forEach(t => colDON.appendChild(makeCard(t)));

    countNEW.textContent = by.NEW.length;
    countTAK.textContent = by.TAKEN.length;
    countDON.textContent = by.DONE.length;
  }

  render();

  sb.channel("tickets_maintenance")
    .on("postgres_changes", {event:"*", schema:"public", table:"tickets"}, render)
    .subscribe();

  searchEl.addEventListener("input", render);
  lineEl.addEventListener("change", render);
  rangeEl.addEventListener("change", render);

  setInterval(render, 2000);
}

// ====== MONITOR ======
async function loadMonitor(){
  app.innerHTML = `
    <div class="header">MONITOR</div>
    <div class="topbar">
      <a class="btn" href="#maintenance">Maintenance</a>
      <a class="btn" href="#line/L1">Line L1</a>
      <div style="opacity:.8;">Yellow ≥ ${YELLOW_AFTER_MIN}min | Red ≥ ${RED_AFTER_MIN}min</div>
    </div>
    <div style="padding:12px;" id="rows"></div>
  `;

  const rowsEl = document.getElementById("rows");

  async function render(){
    const since = new Date(Date.now() - 7*24*60*60*1000).toISOString();

    const { data, error } = await sb
      .from("tickets")
      .select("*")
      .gte("created_at", since)
      .neq("status","CONFIRMED")
      .order("created_at", { ascending:true });

    if (error) { console.error(error); return; }

    const items = (data || [])
      .map(t => ({ t, sec: calcSeconds(t) }))
      .sort((a,b)=>(b.sec||0)-(a.sec||0));

    rowsEl.innerHTML = "";
    items.forEach(({t, sec}) => {
      const card = document.createElement("div");
      card.className = `card ${urgencyClass(sec)}`;
      card.innerHTML = `
        <div class="cardTop">
          <div class="pill">${t.line}</div>
          <div class="timeBig">${formatSec(sec)}</div>
        </div>
        <div class="title">${t.station} — ${t.status}</div>
        <div class="desc">${t.description || ""}</div>
        ${t.maint_comment ? `<div class="meta"><span style="opacity:.7;">Maint</span><span>${t.maint_comment}</span></div>` : ""}
      `;
      rowsEl.appendChild(card);
    });
  }

  render();

  sb.channel("tickets_monitor")
    .on("postgres_changes", {event:"*", schema:"public", table:"tickets"}, render)
    .subscribe();

  setInterval(render, 2000);
}
