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

/*
  IMPORTANT (DB):
  To use "parts used" + automatic stock deduction, your Supabase DB must have:
  - public.spare_parts
  - public.stock
  - public.ticket_parts
  - RPC function: public.apply_ticket_parts(p_ticket_id uuid, p_items jsonb)

  If you haven't created those yet, tell me and I’ll paste the exact SQL again.
*/

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

// Freeze timer when done/confirmed (duration_sec stored when DONE)
function calcSeconds(t) {
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

  if (stopD) return Math.max(0, Math.floor((stopD.getTime() - start) / 1000));
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

// ====== PARTS HELPERS ======
async function findPartByNo(partNo) {
  const { data, error } = await sb
    .from("spare_parts")
    .select("id,part_no,part_name,uom")
    .eq("part_no", partNo)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data; // can be null
}

// Load parts used for a ticket (for display)
async function loadPartsForTicket(ticketId) {
  const { data, error } = await sb
    .from("ticket_parts")
    .select("qty_used, spare_parts(part_no, part_name, uom)")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

function partsListHtml(partsRows) {
  if (!partsRows || partsRows.length === 0) return "";
  const lines = partsRows.map(r => {
    const p = r.spare_parts || {};
    const name = p.part_no ? `${p.part_no} — ${p.part_name || ""}` : (p.part_name || "Part");
    const uom = p.uom || "";
    return `<div class="meta"><span style="opacity:.7;">Part</span><span>${name} × <b>${r.qty_used}</b> ${uom}</span></div>`;
  });
  return `<div style="margin-top:8px;">${lines.join("")}</div>`;
}

// ====== ROUTES ======
// #line/L1   -> operator
// #maintenance -> maintenance board
// #monitor -> monitor
if (route.startsWith("#line/")) loadLine(route.split("/")[1]); // #line/L1
else if (route.startsWith("#monitor")) loadMonitor();
else loadMaintenance();

// ====== OPERATOR (LINE) ======
async function loadLine(line) {
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
      const card = document.createElement("div");
      card.className = `card ${urgencyClass(sec)}`;

      const partsRows = await loadPartsForTicket(t.id);

      card.innerHTML = `
        <div class="cardTop">
          <div class="pill">${t.station}</div>
          <div class="timeBig">${formatSec(sec)}</div>
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
            .update({
              status: "CONFIRMED",
              confirmed_at: new Date().toISOString(),
            })
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
              duration_sec: null, // re-open: unfreeze timer again
              done_at: null, // optional: clear done timestamp so it becomes active again
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
    const wrap = document.createElement("div");
    wrap.style.position = "fixed";
    wrap.style.inset = "0";
    wrap.style.background = "rgba(0,0,0,.7)";
    wrap.style.display = "grid";
    wrap.style.placeItems = "center";
    wrap.style.zIndex = "9999";

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

      if (!desc) {
        alert("Description required.");
        return;
      }

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
        wrap.remove();
      }
    };
  }

  refreshMy();

  sb.channel(`line_${line}_tickets`)
    .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, (payload) => {
      if (payload.new?.line === line || payload.old?.line === line) refreshMy();
    })
    .subscribe();

  setInterval(refreshMy, 2000);
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

  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function toDateInputValue(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // Build ISO range for Postgres (inclusive start, inclusive end)
  function buildRangeISO() {
    const preset = presetEl.value;

    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

    let from = null,
      to = null;

    if (preset === "today") {
      from = startOfToday;
      to = endOfToday;
    } else if (preset === "7" || preset === "30") {
      const days = Number(preset);
      from = new Date(startOfToday.getTime() - (days - 1) * 24 * 60 * 60 * 1000); // includes today
      to = endOfToday;
    } else {
      // custom: read inputs
      if (fromEl.value) {
        const [y, m, d] = fromEl.value.split("-").map(Number);
        from = new Date(y, m - 1, d, 0, 0, 0, 0);
      }
      if (toEl.value) {
        const [y, m, d] = toEl.value.split("-").map(Number);
        to = new Date(y, m - 1, d, 23, 59, 59, 999);
      }
      // fallback if user leaves empty
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
        <div class="timeBig">${formatSec(sec)}</div>
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
        .update({
          status: "TAKEN",
          taken_at: new Date().toISOString(),
          taken_by: name || null,
        })
        .eq("id", t.id);
      if (error) console.error(error);
    };

    const doneBtn = document.createElement("button");
    doneBtn.textContent = "DONE";
    doneBtn.style.background = "#4caf50";
    doneBtn.style.color = "#fff";
    doneBtn.disabled = st !== "TAKEN" && st !== "REOPENED";

    doneBtn.onclick = async () => {
      // 1) required fix comment
      const comment = prompt("Short fix comment (required):", "Fixed / adjusted / replaced…");
      if (!comment || !comment.trim()) {
        alert("Comment required.");
        return;
      }

      // 2) optional parts used (multi)
      // Format: PARTNO=QTY,PARTNO=QTY
      const raw = prompt(
        "Parts used? Format: PARTNO=QTY,PARTNO=QTY (leave empty if none)",
        ""
      );

      try {
        // If parts provided, apply atomic stock deduction + log usage
        if (raw && raw.trim()) {
          const pairs = raw
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);

          const items = [];

          for (const p of pairs) {
            const [noRaw, qtyStrRaw] = p.split("=").map((x) => x.trim());
            const no = (noRaw || "").toUpperCase();
            const qty = Number(qtyStrRaw);

            if (!no || !Number.isFinite(qty) || qty <= 0) {
              alert(`Bad format: ${p}\nUse: PARTNO=QTY,PARTNO=QTY`);
              return;
            }

            const part = await findPartByNo(no);
            if (!part) {
              alert(`Unknown part number: ${no}`);
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

        // 3) freeze duration now (DONE)
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
    if (error) {
      console.error(error);
      return;
    }

    let rows = data || [];

    if (state.q) {
      const needle = state.q;
      rows = rows.filter(
        (t) =>
          String(t.station || "").toLowerCase().includes(needle) ||
          String(t.description || "").toLowerCase().includes(needle)
      );
    }

    // treat REOPENED as NEW bucket (open)
    const by = { NEW: [], TAKEN: [], DONE: [] };
    rows.forEach((t) => {
      const st = String(t.status || "").toUpperCase();
      if (st === "TAKEN") by.TAKEN.push(t);
      else if (st === "DONE") by.DONE.push(t);
      else by.NEW.push(t); // NEW or REOPENED
    });

    // sort by longest waiting first
    ["NEW", "TAKEN", "DONE"].forEach((k) =>
      by[k].sort((a, b) => (calcSeconds(b) || 0) - (calcSeconds(a) || 0))
    );

    colNEW.innerHTML = "";
    colTAK.innerHTML = "";
    colDON.innerHTML = "";

    by.NEW.forEach((t) => colNEW.appendChild(makeCard(t)));
    by.TAKEN.forEach((t) => colTAK.appendChild(makeCard(t)));
    by.DONE.forEach((t) => colDON.appendChild(makeCard(t)));

    countNEW.textContent = by.NEW.length;
    countTAK.textContent = by.TAKEN.length;
    countDON.textContent = by.DONE.length;
  }

  // ===== CSV EXPORT (date selector + filters) =====
  function escCsv(v) {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }

  async function downloadTicketsCSV() {
    readState();
    syncDateInputs();

    const { fromISO, toISO, from, to } = buildRangeISO();

    let q = sb
      .from("tickets")
      .select(
        "id,line,station,priority,issue_type,description,status,created_at,taken_at,done_at,confirmed_at,taken_by,maint_comment,operator_comment,duration_sec"
      )
      .gte("created_at", fromISO)
      .lte("created_at", toISO)
      .order("created_at", { ascending: true });

    if (state.line && state.line !== "ALL") q = q.eq("line", state.line);

    const { data, error } = await q;
    if (error) {
      console.error(error);
      alert("Export failed");
      return;
    }

    let rows = data || [];

    // apply same search filter as UI
    if (state.q) {
      const needle = state.q;
      rows = rows.filter(
        (t) =>
          String(t.station || "").toLowerCase().includes(needle) ||
          String(t.description || "").toLowerCase().includes(needle)
      );
    }

    const cols = [
      "id",
      "line",
      "station",
      "priority",
      "issue_type",
      "description",
      "status",
      "created_at",
      "taken_at",
      "done_at",
      "confirmed_at",
      "taken_by",
      "maint_comment",
      "operator_comment",
      "duration_sec",
    ];

    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => escCsv(r[c])).join(","))].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;

    const f = toDateInputValue(from);
    const t = toDateInputValue(to);
    a.download = `maintenance_${state.line}_${f}_to_${t}.csv`;

    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  exportBtn.onclick = downloadTicketsCSV;

  // initial sync + first render
  syncDateInputs();
  render();

  // realtime + UI events
  sb.channel("tickets_maintenance")
    .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, render)
    .subscribe();

  searchEl.addEventListener("input", render);
  lineEl.addEventListener("change", render);

  presetEl.addEventListener("change", () => {
    syncDateInputs();
    render();
  });

  fromEl.addEventListener("change", () => {
    presetEl.value = "custom";
    syncDateInputs();
    render();
  });

  toEl.addEventListener("change", () => {
    presetEl.value = "custom";
    syncDateInputs();
    render();
  });

  setInterval(render, 2000);
}

// ====== MONITOR ======
async function loadMonitor() {
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

  async function render() {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await sb
      .from("tickets")
      .select("*")
      .gte("created_at", since)
      .neq("status", "CONFIRMED")
      .order("created_at", { ascending: true });

    if (error) {
      console.error(error);
      return;
    }

    const items = (data || [])
      .map((t) => ({ t, sec: calcSeconds(t) }))
      .sort((a, b) => (b.sec || 0) - (a.sec || 0));

    rowsEl.innerHTML = "";
    for (const { t, sec } of items) {
      const partsRows = await loadPartsForTicket(t.id);

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
        ${partsListHtml(partsRows)}
      `;
      rowsEl.appendChild(card);
    }
  }

  render();

  sb.channel("tickets_monitor")
    .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, render)
    .subscribe();

  setInterval(render, 2000);
}
