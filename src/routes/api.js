import express from "express";
import { syncTranslations } from "../services/syncVideos.js";
import { queueMissingExports, pollStatuses } from "../services/exportAndStore.js";
import { initDB } from "../db.js";
import { writeLog } from "../logger.js";

const router = express.Router();

router.post("/sync", async (req, res) => {
    const cutoff = Number(req.body.cutoff) || 0;
    /* writeLog("info", "Manual sync", { imported, cutoff }); */
    const key = req.get("X-HeyGen-Key") || ""; // read custom header
    const imported = await syncTranslations(cutoff, key);
    res.json({ ok: true, imported });
});

router.get("/videos", async (req, res) => {
    const skip = Number(req.query.skip) || 0;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const { videos } = await initDB();
    const [items, total] = await Promise.all([videos.find().skip(skip).limit(limit).sort({ created_at: -1 }).toArray(), videos.countDocuments()]);
    res.json({ items, total });
});

router.post("/process/queue", async (_req, res) => {
    const queued = await queueMissingExports();
    console.log(`queueMissingExports ➜ queued ${queued}`);
    res.json({ ok: true, queued });
});

// === legacy paths expected by the current front‑end ===
router.post("/export/all", async (_req, res) => {
    const queued = await queueMissingExports();
    console.log(`queueMissingExports ➜ queued ${queued}  (via /export/all)`);
    res.json({ ok: true, queued });
});

router.post("/export/status", async (_req, res) => {
    await pollStatuses();
    writeLog("info", "Manual poll");
    res.json({ ok: true });
});

router.post("/process/poll", async (_req, res) => {
    await pollStatuses();
    res.json({ ok: true });
});

// ───────── LOGS ─────────
router.get("/logs", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 40);
    const { db } = await initDB();
    const logs = db.collection("logs");
    const items = await logs
        .find()
        .skip((page - 1) * limit)
        .limit(limit)
        .sort({ ts: -1 })
        .project({ _id: 1, ts: 1, type: 1, message: 1 })
        .toArray();
    res.json({ items });
});

router.get("/logs/:id", async (req, res) => {
    const { db } = await initDB();
    const log = await db.collection("logs").findOne({ _id: new (await import("mongodb")).ObjectId(req.params.id) });
    if (!log) return res.status(404).json({ error: "not found" });
    res.json(log);
});

export default router;
