/*  client‑side table + 15‑s wall‑clock auto refresh  */

document.addEventListener("DOMContentLoaded", () => {
    // tiny helper to avoid repeating null checks
    const el = (id) => document.getElementById(id);

    const tbody = el("tbody");
    const counter = el("counter");
    const cutoffIn = el("cutoffInput");
    const syncBtn = el("syncBtn");
    const exportBtn = el("exportBtn");
    const statusBtn = el("statusBtn");
    const logsBtn = el("logsBtn");
    const refreshIco = el("refreshIcon");

    let skip = 0,
        total = 0,
        loading = false;
    const limit = 50;

    /* ---------- helpers ---------- */
    const a = (url, label) => (url ? `<a href="${url}" target="_blank">${label}</a>` : "-");
    const dbx = (path) => (path ? `<a href="https://www.dropbox.com/home${encodeURI(path)}" target="_blank">DB</a>` : "-");

    /* ---------- table renderer ---------- */
    function renderRow(v) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
        <td>${new Date(v.created_at * 1000).toLocaleString()}</td>
        <td>${v.video_title || ""}</td>
        <td>${v.cc_status || "-"} / ${v.dropbox_status || "-"}</td>
        <td>${v.language || "-"}</td>
        <td>${a(v.download_url, "HG")}</td>
        <td>${a(v.export_url, "CC")}</td>
        <td>${dbx(v.dropbox_path)}</td>`;
        tbody.appendChild(tr);
    }

    /* ---------- batch loader ---------- */
    async function loadBatch() {
        if (loading) return;
        loading = true;
        if (refreshIco) refreshIco.style.display = "inline";
        try {
            const r = await fetch(`/api/videos?skip=${skip}&limit=${limit}`);
            const js = await r.json();
            total = js.total;
            js.items.forEach(renderRow);
            skip += js.items.length;
            if (counter) counter.textContent = `Loaded ${skip}/${total}`;
        } catch (e) {
            console.error("loadBatch failed", e);
        }
        if (refreshIco) refreshIco.style.display = "none";
        loading = false;
    }
    function resetTable() {
        skip = 0;
        tbody.innerHTML = "";
        loadBatch();
    }
    window.addEventListener("scroll", () => {
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) loadBatch();
    });

    /* ---------- buttons ---------- */
    if (syncBtn)
        syncBtn.onclick = async () => {
            const dateStr = cutoffIn?.value;
            const cutoff = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0;
            await fetch("/api/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cutoff }),
            });
            resetTable();
        };

    if (exportBtn)
        exportBtn.onclick = async () => {
            const r = await fetch("/api/export/all", { method: "POST" });
            const j = await r.json();
            alert(`Queued ${j.queued} CloudConvert job${j.queued === 1 ? "" : "s"}.`);
            resetTable();
        };

    if (statusBtn)
        statusBtn.onclick = async () => {
            await fetch("/api/export/status", { method: "POST" });
            resetTable();
        };

    if (logsBtn)
        logsBtn.onclick = () => {
            window.location.href = "/logs.html";
        };

    /* ---------- 15‑second wall‑clock auto‑refresh ---------- */
    const POLL_MS = 15_000;
    let next = Date.now() + POLL_MS;

    async function pollLoop() {
        if (refreshIco) refreshIco.style.display = "inline";
        try {
            await fetch("/api/export/status", { method: "POST" });
            resetTable();
        } catch (e) {
            console.error("auto‑poll failed", e);
        }
        if (refreshIco) refreshIco.style.display = "none";

        next += POLL_MS;
        setTimeout(pollLoop, Math.max(0, next - Date.now()));
    }
    setTimeout(pollLoop, POLL_MS);

    /* ---------- first load ---------- */
    loadBatch();
});
