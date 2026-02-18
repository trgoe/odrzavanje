// ====== LOAD GUARD (prevents duplicate app.js instances) ======
if (window.__MAINT_APP_LOADED__) {
  console.warn("maintenance app.js loaded twice — aborting second load");
  throw new Error("app.js loaded twice");
}
window.__MAINT_APP_LOADED__ = true;

console.log("maintenance app.js loaded");

// ====== CONFIG ======
const SUPABASE_URL = "https://hfyvjtaumvmaqeqkmiyk.supabase.co";
const SUPABASE_KEY = "YOUR_ANON_KEY_HERE"; // <-- keep yours
const YELLOW_AFTER_MIN = 5;
const RED_AFTER_MIN = 10;

// ====== INIT ======
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById("app");

// ====== TIME HELPERS ======
function parseTs(ts) {
  if (!ts) return null;
  let s = String(ts).trim();
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  const hasTZ = /Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s);
  if (!hasTZ) s += "Z";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function fmtDateTime(ts) {
  const d = parseTs(ts);
  if (!d) return "-";
  return d.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatSec(sec) {
  if (sec == null) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.max(0, sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function urgencyClass(sec) {
  if (sec == null) return "";
  if (sec >= RED_AFTER_MIN * 60) return "uRed";
  if (sec >= YELLOW_AFTER_MIN * 60) return "uYellow";
  return "uGreen";
}

// freeze logic from ticket object
function calcSeconds(t) {
  const startD = parseTs(t?.created_at);
  if (!startD) return null;
  const start = startD.getTime();

  if (t.duration_sec != null && Number.isFinite(Number(t.duration_sec))) {
    return Number(t.duration_sec);
  }

  const st = String(t.status || "").toUpperCase();
  let stopD = null;

  if ((st === "CONFIRMED" || st === "REOPENED") && t.confirmed_at) stopD = parseTs(t.confirmed_at);
  if (!stopD && (st === "DONE" || st === "CONFIRMED" || st === "REOPENED") && t.done_at) stopD = parseTs(t.done_at);

  if (stopD) return Math.max(0, Math.floor((stopD.getTime() - start) / 1000));
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

// ====== LIVE TIMER (NO RE-FETCH) ======
function secondsFromDataset(el) {
  const createdAt = el.dataset.createdAt;
  if (!createdAt) return null;

  const start = parseTs(createdAt)?.getTime();
  if (!start) return null;

  const dur = el.dataset.durationSec;
  if (dur != null && dur !== "" && Number.isFinite(Number(dur))) {
    return Number(dur);
  }

  const status = (el.dataset.status || "").toUpperCase();
  const doneAt = el.dataset.doneAt;
  const confAt = el.dataset.confirmedAt;

  let stop = null;
  if ((status === "CONFIRMED" || status === "REOPENED") && confAt) stop = parseTs(confAt)?.getTime();
  if (!stop && (status === "DONE" || status === "CONFIRMED" || status === "REOPENED") && doneAt) stop = parseTs(doneAt)?.getTime();

  if (stop) return Math.max(0, Math.floor((stop - start) / 1000));
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

function updateTimersOnly() {
  document.querySelectorAll("[data-timer='1']").forEach((el) => {
    const sec = secondsFromDataset(el);
    el.textContent = formatSec(sec);
  });
}

if (window.__MAINT_TIMER_INTERVAL) clearInterval(window.__MAINT_TIMER_INTERVAL);
window.__MAINT_TIMER_INTERVAL = setInterval(updateTimersOnly, 1000);

// ====== CSV HELPERS ======
function escCsv(v) {
  if (v == null) return "";
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function toDateInputValue(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

// ====== MODAL HELPER ======
function showModal(innerHtml) {
  const wrap = document.createElement("div");
  wrap.style.position = "fixed";
  wrap.style.inset = "0";
  wrap.style.background = "rgba(0,0,0,.7)";
  wrap.style.display = "grid";
  wrap.style.placeItems = "center";
  wrap.style.zIndex = "9999";
  wrap.innerHTML = innerHtml;
  document.body.appendChild(wrap);
  return { el: wrap, close: () => wrap.remove() };
}

// ====== PARTS HELPERS ======
async function findPartByNo(partNo) {
  const { data, error } = await sb
    .from("spare_parts")
    .select("id,part_no,part_name,uom,is_active")
    .eq("part_no", partNo)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadPartsForTicket(ticketId) {
  const { data, error } = await sb
    .from("ticket_parts")
    .select("qty_used, spare_parts(part_no, part_name, uom)")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  if (error) { console.error(error); return []; }
  return data || [];
}

function partsListHtml(partsRows) {
  if (!partsRows || partsRows.length === 0) return "";
  const lines = partsRows.map((r) => {
    const p = r.spare_parts || {};
    const name = p.part_no ? `${p.part_no} — ${p.part_name || ""}` : (p.part_name || "Part");
    const uom = p.uom || "";
    return `<div class="meta"><span style="opacity:.7;">Part</span><span>${name} × <b>${r.qty_used}</b> ${uom}</span></div>`;
  });
  return `<div style="margin-top:8px;">${lines.join("")}</div>`;
}

// ====== ROUTER + CLEANUP ======
async function cleanupActive() {
  if (window.__linePoll) { clearInterval(window.__linePoll); window.__linePoll = null; }
  if (window.__maintenancePoll) { clearInterval(window.__maintenancePoll); window.__maintenancePoll = null; }
  if (window.__monitorPoll) { clearInterval(window.__monitorPoll); window.__monitorPoll = null; }

  if (window.__lineChannel) { try { await sb.removeChannel(window.__lineChannel); } catch (e) {} window.__lineChannel = null; }
  if (window.__maintenanceChannel) { try { await sb.removeChannel(window.__maintenanceChannel); } catch (e) {} window.__maintenanceChannel = null; }
  if (window.__monitorChannel) { try { await sb.removeChannel(window.__monitorChannel); } catch (e) {} window.__monitorChannel = null; }
  if (window.__partsChannel1) { try { await sb.removeChannel(window.__partsChannel1); } catch (e) {} window.__partsChannel1 = null; }
  if (window.__partsChannel2) { try { await sb.removeChannel(window.__partsChannel2); } catch (e) {} window.__partsChannel2 = null; }
}

async function router() {
  await cleanupActive();
  const r = location.hash || "#maintenance";
  if (r.startsWith("#line/")) return loadLine(r.split("/")[1]);
  if (r.startsWith("#monitor")) return loadMonitor();
  if (r.startsWith("#parts")) return loadPartsScreen();
  return loadMaintenance();
}

window.addEventListener("hashchange", router);

// ====== OPERATOR (LINE) ======
async function loadLine(line) {
  app.innerHTML = `
    <div class="header">LINE ${line} — Maintenance Call</div>

    <div class="topbar">
      <a class="btn" href="#maintenance">Maintenance</a>
      <a class="btn" href="#monitor">Monitor</a>
      <a class="btn" href="#parts">Spare Parts</a>
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

  const { data: stations, error: stErr } = await sb
    .from("stations")
    .select("*")
    .eq("line", line)
    .eq("is_active", true)
    .order("sort", { ascending: true });

  if (stErr) console.error(stErr);

  (stations || []).forEach((s) => {
    const btn = document.createElement("button");
    btn.className = "btn btnBlue";
    btn.style.textAlign = "left";
    btn.innerHTML = `
      <div style="font-weight:1000;font-size:18px;">${s.station}</div>
      <div style="opacity:.8;font-size:12px;">Tap to create ticket</div>
    `;
    btn.onclick = () => openCreateTicketModal(line, s.station);
    stationsEl.appendChild(btn);
  });

  async function refreshMy() {
    const { data, error } = await sb
      .from("tickets")
      .select("*")
      .eq("line", line)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) console.error(error);

    myEl.innerHTML = "";

    for (const t of (data || [])) {
      const sec = calcSeconds(t);
      const partsRows = await loadPartsForTicket(t.id);

      const card = document.createElement("div");
      card.className = `card ${urgencyClass(sec)}`;

      card.innerHTML = `
        <div class="cardTop">
          <div class="pill">${t.station}</div>
          <div class="timeBig"
               data-timer="1"
               data-created-at="${t.created_at || ""}"
               data-status="${t.status || ""}"
               data-done-at="${t.done_at || ""}"
               data-confirmed-at="${t.confirmed_at || ""}"
               data-duration-sec="${t.duration_sec ?? ""}">${formatSec(sec)}</div>
        </div>

        <div class="title">${t.priority} — ${t.status}</div>
        <div class="desc">${t.description || ""}</div>

        <div class="meta"><span style="opacity:.7;">Created</span><span>${fmtDateTime(t.created_at)}</span></div>
        ${t.maint_comment ? `<div class="meta"><span style="opacity:.7;">Maint</span><span>${t.maint_comment}</span></div>` : ""}
        ${t.operator_comment ? `<div class="meta"><span style="opacity:.7;">Operator</span><span>${t.operator_comment}</span></div>` : ""}
        ${partsListHtml(partsRows)}

        <div class="actions" id="opBtns-${t.id}" style="margin-top:10px;"></div>
      `;

      const btnBox = card.querySelector(`#opBtns-${t.id}`);
      const st = String(t.status || "").toUpperCase();

      if (st === "DONE") {
        const ok = document.createElement("button");
        ok.className = "btnGreen";
        ok.textContent = "CONFIRM";
        ok.onclick = async () => {
          const { error } = await sb
            .from("tickets")
            .update({ status: "CONFIRMED", confirmed_at: new Date().toISOString() })
            .eq("id", t.id);
          if (error) console.error(error);
        };

        const reopen = document.createElement("button");
        reopen.className = "btnRed";
        reopen.textContent = "NOT FIXED";
        reopen.onclick = async () => {
          const reason = prompt("Short reason (optional):", "Still not working");
          const { error } = await sb
            .from("tickets")
            .update({
              status: "REOPENED",
              confirmed_at: new Date().toISOString(),
              operator_comment: reason || null,
              duration_sec: null,
              done_at: null,
            })
            .eq("id", t.id);
          if (error) console.error(error);
        };

        btnBox.appendChild(ok);
        btnBox.appendChild(reopen);
      } else {
        btnBox.innerHTML = `<div style="opacity:.7;">Waiting for maintenance / in progress…</div>`;
      }

      myEl.appendChild(card);
    }
  }

  function openCreateTicketModal(line, station) {
    const modal = showModal(`
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
    `);

    modal.el.querySelector("#cancel").onclick = modal.close;

    modal.el.querySelector("#send").onclick = async () => {
      const prio = modal.el.querySelector("#prio").value;
      const issue = modal.el.querySelector("#issue").value.trim();
      const desc = modal.el.querySelector("#desc").value.trim();

      if (!desc) { alert("Description required."); return; }

      const { error } = await sb.from("tickets").insert({
        line,
        station,
        priority: prio,
        issue_type: issue || null,
        description: desc,
        status: "NEW",
        created_at: new Date().toISOString(),
      });

      if (error) {
        console.error(error);
        alert("Failed to create ticket");
      } else {
        modal.close();
        refreshMy(); // ✅ instant local update
      }
    };
  }

  // initial load
  await refreshMy();

  // Debounce + prevent overlapping refreshes
  let refreshInFlight = false;
  let refreshQueued = false;
  let refreshTimer = null;

  async function safeRefresh() {
    if (refreshInFlight) { refreshQueued = true; return; }
    refreshInFlight = true;
    try { await refreshMy(); }
    finally {
      refreshInFlight = false;
      if (refreshQueued) { refreshQueued = false; safeRefresh(); }
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(safeRefresh, 150);
  }

  // Realtime only for THIS line
  window.__lineChannel = sb
    .channel(`line_${line}_tickets`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "tickets", filter: `line=eq.${line}` },
      scheduleRefresh
    )
    .subscribe();

  // fallback poll (handles cases where realtime doesn't fire)
  window.__linePoll = setInterval(scheduleRefresh, 3000);
}

// ====== MAINTENANCE BOARD ======
async function loadMaintenance() {
  const state = { q: "", line: "ALL" };

  app.innerHTML = `
    <div class="header">MAINTENANCE</div>

    <div class="topbar" style="flex-wrap:wrap;">
      <input id="search" class="input" placeholder="Search station/desc..." />

      <select id="lineFilter" class="select">
        <option value="ALL">All lines</option>
        ${Array.from({ length: 9 }, (_, i) => `<option value="L${i + 1}">L${i + 1}</option>`).join("")}
      </select>

      <select id="rangePreset" class="select">
        <option value="today">Today</option>
        <option value="7">Last 7 days</option>
        <option value="30" selected>Last 30 days</option>
        <option value="custom">Custom</option>
      </select>

      <input id="dateFrom" class="input" type="date" />
      <input id="dateTo" class="input" type="date" />

      <button id="btnExport" class="btn btnBlue">Export CSV</button>

      <a class="btn" href="#monitor">Monitor</a>
      <a class="btn" href="#parts">Spare Parts</a>
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
  const lineEl = document.getElementById("lineFilter");
  const presetEl = document.getElementById("rangePreset");
  const fromEl = document.getElementById("dateFrom");
  const toEl = document.getElementById("dateTo");
  const exportBtn = document.getElementById("btnExport");

  const colNEW = document.getElementById("colNEW");
  const colTAK = document.getElementById("colTAKEN");
  const colDON = document.getElementById("colDONE");

  const countNEW = document.getElementById("countNEW");
  const countTAK = document.getElementById("countTAKEN");
  const countDON = document.getElementById("countDONE");

  function readState() {
    state.q = (searchEl.value || "").trim().toLowerCase();
    state.line = lineEl.value || "ALL";
  }

  function buildRangeISO() {
    const preset = presetEl.value;

    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

    let from = null, to = null;

    if (preset === "today") {
      from = startOfToday; to = endOfToday;
    } else if (preset === "7" || preset === "30") {
      const days = Number(preset);
      from = new Date(startOfToday.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
      to = endOfToday;
    } else {
      if (fromEl.value) {
        const [y, m, d] = fromEl.value.split("-").map(Number);
        from = new Date(y, m - 1, d, 0, 0, 0, 0);
      }
      if (toEl.value) {
        const [y, m, d] = toEl.value.split("-").map(Number);
        to = new Date(y, m - 1, d, 23, 59, 59, 999);
      }
      if (!from) from = new Date(startOfToday.getTime() - 29 * 24 * 60 * 60 * 1000);
      if (!to) to = endOfToday;
    }

    return { fromISO: from.toISOString(), toISO: to.toISOString(), from, to };
  }

  function syncDateInputs() {
    const { from, to } = buildRangeISO();
    if (presetEl.value !== "custom") {
      fromEl.value = toDateInputValue(from);
      toEl.value = toDateInputValue(to);
      fromEl.disabled = true;
      toEl.disabled = true;
    } else {
      fromEl.disabled = false;
      toEl.disabled = false;
      if (!fromEl.value) fromEl.value = toDateInputValue(from);
      if (!toEl.value) toEl.value = toDateInputValue(to);
    }
  }

  function makeCard(t) {
    const sec = calcSeconds(t);
    const card = document.createElement("div");
    card.className = `card ${urgencyClass(sec)}`;

    card.innerHTML = `
      <div class="cardTop">
        <div class="pill">${t.line}</div>
        <div class="timeBig"
             data-timer="1"
             data-created-at="${t.created_at || ""}"
             data-status="${t.status || ""}"
             data-done-at="${t.done_at || ""}"
             data-confirmed-at="${t.confirmed_at || ""}"
             data-duration-sec="${t.duration_sec ?? ""}">${formatSec(sec)}</div>
      </div>

      <div class="title">${t.station} — ${t.priority}</div>
      <div class="desc">${t.description || ""}</div>

      <div class="meta">
        <div style="opacity:.75;">${t.status}</div>
        <div style="opacity:.75;">${t.issue_type || ""}</div>
      </div>

      ${t.maint_comment ? `<div class="meta"><span style="opacity:.7;">Maint</span><span>${t.maint_comment}</span></div>` : ""}
      <div class="meta"><span style="opacity:.7;">Created</span><span>${fmtDateTime(t.created_at)}</span></div>

      <div class="actions" id="btns-${t.id}" style="margin-top:10px;"></div>
    `;

    const btns = card.querySelector(`#btns-${t.id}`);
    const st = String(t.status || "").toUpperCase();

    const takeBtn = document.createElement("button");
    takeBtn.textContent = "TAKE";
    takeBtn.style.background = "#2b7cff";
    takeBtn.style.color = "#fff";
    takeBtn.disabled = st !== "NEW";
    takeBtn.onclick = async () => {
      const name = prompt("Your name (optional):", "");
      const { error } = await sb
        .from("tickets")
        .update({ status: "TAKEN", taken_at: new Date().toISOString(), taken_by: name || null })
        .eq("id", t.id);
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

      const raw = prompt("Parts used? Format: PARTNO=QTY,PARTNO=QTY (leave empty if none)", "");

      try {
        if (raw && raw.trim()) {
          const pairs = raw.split(",").map(x => x.trim()).filter(Boolean);
          const items = [];

          for (const p of pairs) {
            const [noRaw, qtyStrRaw] = p.split("=").map(x => x.trim());
            const no = (noRaw || "").toUpperCase();
            const qty = Number(qtyStrRaw);

            if (!no || !Number.isFinite(qty) || qty <= 0) {
              alert(`Bad format: ${p}\nUse: PARTNO=QTY,PARTNO=QTY`);
              return;
            }

            const part = await findPartByNo(no);
            if (!part || part.is_active === false) {
              alert(`Unknown or inactive part number: ${no}`);
              return;
            }

            items.push({ part_id: part.id, qty });
          }

          const { error: rpcErr } = await sb.rpc("apply_ticket_parts", {
            p_ticket_id: t.id,
            p_items: items,
          });

          if (rpcErr) {
            console.error(rpcErr);
            alert(`Stock update failed: ${rpcErr.message}`);
            return;
          }
        }

        const start = parseTs(t.created_at)?.getTime();
        const now = Date.now();
        const duration = start ? Math.max(0, Math.floor((now - start) / 1000)) : null;

        const { error } = await sb
          .from("tickets")
          .update({
            status: "DONE",
            done_at: new Date(now).toISOString(),
            maint_comment: comment.trim(),
            duration_sec: duration,
          })
          .eq("id", t.id);

        if (error) console.error(error);
      } catch (e) {
        console.error(e);
        alert(`Error: ${e?.message || e}`);
      }
    };

    btns.appendChild(takeBtn);
    btns.appendChild(doneBtn);

    return card;
  }

  async function render() {
    readState();
    syncDateInputs();

    const { fromISO, toISO } = buildRangeISO();

    let q = sb
      .from("tickets")
      .select("*")
      .gte("created_at", fromISO)
      .lte("created_at", toISO)
      .in("status", ["NEW", "TAKEN", "DONE", "REOPENED"])
      .order("created_at", { ascending: true });

    if (state.line !== "ALL") q = q.eq("line", state.line);

    const { data, error } = await q;
    if (error) { console.error(error); return; }

    let rows = data || [];

    if (state.q) {
      const needle = state.q;
      rows = rows.filter(t =>
        String(t.station || "").toLowerCase().includes(needle) ||
        String(t.description || "").toLowerCase().includes(needle)
      );
    }

    const by = { NEW: [], TAKEN: [], DONE: [] };
    rows.forEach(t => {
      const st = String(t.status || "").toUpperCase();
      if (st === "TAKEN") by.TAKEN.push(t);
      else if (st === "DONE") by.DONE.push(t);
      else by.NEW.push(t);
    });

    ["NEW", "TAKEN", "DONE"].forEach(k =>
      by[k].sort((a, b) => (calcSeconds(b) || 0) - (calcSeconds(a) || 0))
    );

    colNEW.innerHTML = "";
    colTAK.innerHTML = "";
    colDON.innerHTML = "";

    by.NEW.forEach(t => colNEW.appendChild(makeCard(t)));
    by.TAKEN.forEach(t => colTAK.appendChild(makeCard(t)));
    by.DONE.forEach(t => colDON.appendChild(makeCard(t)));

    countNEW.textContent = by.NEW.length;
    countTAK.textContent = by.TAKEN.length;
    countDON.textContent = by.DONE.length;
  }

  async function downloadTicketsCSV() {
    readState();
    syncDateInputs();

    const { fromISO, toISO, from, to } = buildRangeISO();

    let q = sb
      .from("tickets")
      .select("id,line,station,priority,issue_type,description,status,created_at,taken_at,done_at,confirmed_at,taken_by,maint_comment,operator_comment,duration_sec")
      .gte("created_at", fromISO)
      .lte("created_at", toISO)
      .order("created_at", { ascending: true });

    if (state.line && state.line !== "ALL") q = q.eq("line", state.line);

    const { data, error } = await q;
    if (error) { console.error(error); alert("Export failed"); return; }

    let rows = data || [];
    if (state.q) {
      const needle = state.q;
      rows = rows.filter(t =>
        String(t.station || "").toLowerCase().includes(needle) ||
        String(t.description || "").toLowerCase().includes(needle)
      );
    }

    const cols = ["id","line","station","priority","issue_type","description","status","created_at","taken_at","done_at","confirmed_at","taken_by","maint_comment","operator_comment","duration_sec"];
    const csv = [cols.join(","), ...rows.map(r => cols.map(c => escCsv(r[c])).join(","))].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `maintenance_${state.line}_${toDateInputValue(from)}_to_${toDateInputValue(to)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  exportBtn.onclick = downloadTicketsCSV;

  syncDateInputs();
  await render();

  window.__maintenanceChannel = sb
    .channel("tickets_maintenance")
    .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, render)
    .subscribe();

  window.__maintenancePoll = setInterval(render, 3000);

  searchEl.addEventListener("input", render);
  lineEl.addEventListener("change", render);
  presetEl.addEventListener("change", () => { syncDateInputs(); render(); });
  fromEl.addEventListener("change", () => { presetEl.value = "custom"; syncDateInputs(); render(); });
  toEl.addEventListener("change", () => { presetEl.value = "custom"; syncDateInputs(); render(); });
}

// ====== MONITOR ======
async function loadMonitor() {
  app.innerHTML = `
    <div class="header">MONITOR</div>
    <div class="topbar">
      <a class="btn" href="#maintenance">Maintenance</a>
      <a class="btn" href="#parts">Spare Parts</a>
      <a class="btn" href="#line/L1">Line L1</a>
      <div style="opacity:.8;">Yellow ≥ ${YELLOW_AFTER_MIN}min | Red ≥ ${RED_AFTER_MIN}min</div>
    </div>
    <div style="padding:12px;" id="rows"></div>
  `;

  const rowsEl = document.getElementById("rows");

  async function render() {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await sb
      .from("tickets")
      .select("*")
      .gte("created_at", since)
      .neq("status", "CONFIRMED")
      .order("created_at", { ascending: true });

    if (error) { console.error(error); return; }

    const items = (data || [])
      .map(t => ({ t, sec: calcSeconds(t) }))
      .sort((a, b) => (b.sec || 0) - (a.sec || 0));

    rowsEl.innerHTML = "";
    for (const { t, sec } of items) {
      const partsRows = await loadPartsForTicket(t.id);

      const card = document.createElement("div");
      card.className = `card ${urgencyClass(sec)}`;

      card.innerHTML = `
        <div class="cardTop">
          <div class="pill">${t.line}</div>
          <div class="timeBig"
               data-timer="1"
               data-created-at="${t.created_at || ""}"
               data-status="${t.status || ""}"
               data-done-at="${t.done_at || ""}"
               data-confirmed-at="${t.confirmed_at || ""}"
               data-duration-sec="${t.duration_sec ?? ""}">${formatSec(sec)}</div>
        </div>
        <div class="title">${t.station} — ${t.status}</div>
        <div class="desc">${t.description || ""}</div>
        ${t.maint_comment ? `<div class="meta"><span style="opacity:.7;">Maint</span><span>${t.maint_comment}</span></div>` : ""}
        ${partsListHtml(partsRows)}
      `;
      rowsEl.appendChild(card);
    }
  }

  await render();

  window.__monitorChannel = sb
    .channel("tickets_monitor")
    .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, render)
    .subscribe();

  window.__monitorPoll = setInterval(render, 3000);
}

// ====== PARTS / STOCK SCREEN (EDITABLE) ======
async function loadPartsScreen() {
  const state = { q: "", onlyActive: true };

  app.innerHTML = `
    <div class="header">SPARE PARTS / STOCK</div>

    <div class="topbar" style="flex-wrap:wrap;">
      <a class="btn" href="#maintenance">Maintenance</a>
      <a class="btn" href="#monitor">Monitor</a>

      <input id="search" class="input" placeholder="Search part no / name..." style="min-width:220px;" />

      <select id="activeFilter" class="select">
        <option value="active" selected>Active only</option>
        <option value="all">All (incl. inactive)</option>
      </select>

      <button id="btnAdd" class="btn btnBlue">+ Add part</button>
      <button id="btnExport" class="btn">Export CSV</button>
    </div>

    <div style="padding:12px;">
      <div style="opacity:.75;margin-bottom:8px;">
        Tip: set <b>Min Qty</b> to get low-stock highlighting.
      </div>

      <div id="list" style="display:grid;gap:10px;"></div>
    </div>
  `;

  const searchEl = document.getElementById("search");
  const activeEl = document.getElementById("activeFilter");
  const addBtn = document.getElementById("btnAdd");
  const exportBtn = document.getElementById("btnExport");
  const listEl = document.getElementById("list");

  function readState() {
    state.q = (searchEl.value || "").trim().toLowerCase();
    state.onlyActive = (activeEl.value === "active");
  }

  function lowStockClass(qty, min) {
    const q = Number(qty ?? 0);
    const m = Number(min ?? 0);
    if (q <= m) return "uRed";
    return "uGreen";
  }

  async function fetchParts() {
    const { data, error } = await sb
      .from("stock")
      .select("qty,min_qty,location, spare_parts(id,part_no,part_name,uom,is_active)")
      .order("qty", { ascending: true });

    if (error) { console.error(error); return []; }

    let rows = (data || [])
      .map(r => ({ qty: r.qty, min_qty: r.min_qty, location: r.location, part: r.spare_parts }))
      .filter(x => x.part);

    if (state.onlyActive) rows = rows.filter(x => x.part.is_active !== false);

    if (state.q) {
      const n = state.q;
      rows = rows.filter(x =>
        String(x.part.part_no || "").toLowerCase().includes(n) ||
        String(x.part.part_name || "").toLowerCase().includes(n)
      );
    }

    rows.sort((a, b) => {
      const aLow = Number(a.qty ?? 0) <= Number(a.min_qty ?? 0) ? 0 : 1;
      const bLow = Number(b.qty ?? 0) <= Number(b.min_qty ?? 0) ? 0 : 1;
      if (aLow !== bLow) return aLow - bLow;
      return String(a.part.part_no || "").localeCompare(String(b.part.part_no || ""));
    });

    return rows;
  }

  function openAddModal() {
    const modal = showModal(`
      <div class="card" style="width:min(700px,92vw);">
        <div style="font-weight:1000;font-size:20px;">Add spare part</div>
        <div style="height:10px;"></div>

        <div style="display:grid;gap:10px;">
          <input id="part_no" class="input" placeholder="Part No (unique) e.g. VAC-001" />
          <input id="part_name" class="input" placeholder="Part name e.g. Vacuum cup 30mm" />
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <input id="uom" class="input" placeholder="UoM (pcs)" style="max-width:140px;" />
            <input id="qty" class="input" type="number" step="1" placeholder="Qty" style="max-width:160px;" />
            <input id="min_qty" class="input" type="number" step="1" placeholder="Min Qty" style="max-width:160px;" />
            <input id="location" class="input" placeholder="Location (optional)" style="flex:1;min-width:180px;" />
          </div>
        </div>

        <div style="height:12px;"></div>
        <div style="display:flex;gap:10px;">
          <button id="cancel" class="btn">Cancel</button>
          <button id="save" class="btn btnBlue" style="flex:1;">SAVE</button>
        </div>
      </div>
    `);

    modal.el.querySelector("#cancel").onclick = modal.close;

    modal.el.querySelector("#save").onclick = async () => {
      const part_no = modal.el.querySelector("#part_no").value.trim().toUpperCase();
      const part_name = modal.el.querySelector("#part_name").value.trim();
      const uom = (modal.el.querySelector("#uom").value.trim() || "pcs").toLowerCase();
      const qty = Number(modal.el.querySelector("#qty").value || 0);
      const min_qty = Number(modal.el.querySelector("#min_qty").value || 0);
      const location = modal.el.querySelector("#location").value.trim();

      if (!part_no || !part_name) { alert("Part No and Part name are required."); return; }
      if (!Number.isFinite(qty) || qty < 0) { alert("Qty must be 0 or more."); return; }
      if (!Number.isFinite(min_qty) || min_qty < 0) { alert("Min Qty must be 0 or more."); return; }

      const { data: inserted, error: pErr } = await sb
        .from("spare_parts")
        .insert({ part_no, part_name, uom, is_active: true })
        .select("id")
        .single();

      if (pErr) { console.error(pErr); alert(pErr.message); return; }

      const { error: sErr } = await sb
        .from("stock")
        .insert({ part_id: inserted.id, qty, min_qty, location: location || null });

      if (sErr) { console.error(sErr); alert(sErr.message); return; }

      modal.close();
      render();
    };
  }

  function openEditModal(row) {
    const p = row.part;
    const modal = showModal(`
      <div class="card" style="width:min(760px,92vw);">
        <div style="font-weight:1000;font-size:20px;">Edit part — ${p.part_no}</div>
        <div style="height:10px;"></div>

        <div style="display:grid;gap:10px;">
          <div class="meta"><span style="opacity:.7;">ID</span><span>${p.id}</span></div>

          <input id="part_name" class="input" placeholder="Part name" value="${(p.part_name || "").replace(/"/g, "&quot;")}" />
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <input id="uom" class="input" placeholder="UoM" style="max-width:140px;" value="${(p.uom || "pcs").replace(/"/g, "&quot;")}" />
            <input id="qty" class="input" type="number" step="1" placeholder="Qty" style="max-width:160px;" value="${Number(row.qty ?? 0)}" />
            <input id="min_qty" class="input" type="number" step="1" placeholder="Min Qty" style="max-width:160px;" value="${Number(row.min_qty ?? 0)}" />
            <input id="location" class="input" placeholder="Location" style="flex:1;min-width:180px;" value="${(row.location || "").replace(/"/g, "&quot;")}" />
          </div>

          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
            <label style="display:flex;align-items:center;gap:8px;opacity:.9;">
              <input id="is_active" type="checkbox" ${p.is_active === false ? "" : "checked"} />
              Active
            </label>
            <div style="opacity:.7;">(Deactivate hides from selection, history stays.)</div>
          </div>
        </div>

        <div style="height:12px;"></div>
        <div style="display:flex;gap:10px;">
          <button id="cancel" class="btn">Cancel</button>
          <button id="save" class="btn btnBlue" style="flex:1;">SAVE</button>
        </div>
      </div>
    `);

    modal.el.querySelector("#cancel").onclick = modal.close;

    modal.el.querySelector("#save").onclick = async () => {
      const part_name = modal.el.querySelector("#part_name").value.trim();
      const uom = (modal.el.querySelector("#uom").value.trim() || "pcs").toLowerCase();
      const qty = Number(modal.el.querySelector("#qty").value || 0);
      const min_qty = Number(modal.el.querySelector("#min_qty").value || 0);
      const location = modal.el.querySelector("#location").value.trim();
      const is_active = !!modal.el.querySelector("#is_active").checked;

      if (!part_name) { alert("Part name is required."); return; }
      if (!Number.isFinite(qty) || qty < 0) { alert("Qty must be 0 or more."); return; }
      if (!Number.isFinite(min_qty) || min_qty < 0) { alert("Min Qty must be 0 or more."); return; }

      const { error: pErr } = await sb
        .from("spare_parts")
        .update({ part_name, uom, is_active })
        .eq("id", p.id);
      if (pErr) { console.error(pErr); alert(pErr.message); return; }

      const { error: sErr } = await sb
        .from("stock")
        .update({ qty, min_qty, location: location || null })
        .eq("part_id", p.id);
      if (sErr) { console.error(sErr); alert(sErr.message); return; }

      modal.close();
      render();
    };
  }

  async function exportCSV() {
    readState();
    const rows = await fetchParts();

    const cols = ["part_no","part_name","uom","qty","min_qty","location","is_active"];
    const csv = [
      cols.join(","),
      ...rows.map(r => {
        const p = r.part;
        const obj = {
          part_no: p.part_no,
          part_name: p.part_name,
          uom: p.uom,
          qty: r.qty,
          min_qty: r.min_qty,
          location: r.location,
          is_active: p.is_active
        };
        return cols.map(c => escCsv(obj[c])).join(",");
      })
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `spare_parts_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function render() {
    readState();
    const rows = await fetchParts();

    listEl.innerHTML = "";
    if (rows.length === 0) {
      listEl.innerHTML = `<div class="card" style="opacity:.8;">No parts found.</div>`;
      return;
    }

    rows.forEach(r => {
      const p = r.part;
      const qty = Number(r.qty ?? 0);
      const minq = Number(r.min_qty ?? 0);
      const low = qty <= minq;

      const card = document.createElement("div");
      card.className = `card ${lowStockClass(qty, minq)}`;

      card.innerHTML = `
        <div class="cardTop">
          <div class="pill">${p.part_no}</div>
          <div style="font-weight:1000;font-size:18px;">${qty} ${p.uom || ""}</div>
        </div>

        <div class="title">${p.part_name || ""}</div>

        <div class="meta">
          <div><span style="opacity:.7;">Min</span> <b>${minq}</b></div>
          <div><span style="opacity:.7;">Location</span> ${r.location || "-"}</div>
        </div>

        <div class="meta">
          <div style="opacity:.75;">${p.is_active === false ? "INACTIVE" : (low ? "LOW STOCK" : "OK")}</div>
        </div>

        <div class="actions" style="margin-top:10px;"></div>
      `;

      const actions = card.querySelector(".actions");
      const editBtn = document.createElement("button");
      editBtn.className = "btn btnBlue";
      editBtn.textContent = "EDIT";
      editBtn.onclick = () => openEditModal(r);

      actions.appendChild(editBtn);
      listEl.appendChild(card);
    });
  }

  addBtn.onclick = openAddModal;
  exportBtn.onclick = exportCSV;

  searchEl.addEventListener("input", render);
  activeEl.addEventListener("change", render);

  await render();

  window.__partsChannel1 = sb
    .channel("parts_live_spare_parts")
    .on("postgres_changes", { event: "*", schema: "public", table: "spare_parts" }, render)
    .subscribe();

  window.__partsChannel2 = sb
    .channel("parts_live_stock")
    .on("postgres_changes", { event: "*", schema: "public", table: "stock" }, render)
    .subscribe();
}

// ====== START ======
router();
