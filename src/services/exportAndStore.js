// src/services/exportAndStore.js  –  v2.3.2  (always stores dropbox_path & dropbox_url)
import axios from "axios";
import fetch from "node-fetch";
import { initDB } from "../db.js";
import dotenv from "dotenv";
dotenv.config();

/* ───── CloudConvert ───── */
const CC_API = "https://api.cloudconvert.com/v2";
const CC_HDR = {
    Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}`,
    "Content-Type": "application/json",
};
const ccJobBody = (v) => ({
    tasks: {
        "import-url": {
            operation: "import/url",
            url: v.download_url,
            filename: `${v.video_id}.mp4`,
        },
        "export-url": { operation: "export/url", input: "import-url" },
    },
});

/* ───── Dropbox ───── */
const DBX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const ROOT = (process.env.DROPBOX_FOLDER || "/HeyGenVideos").replace(/\/+$/, "");
const dbxHeaders = {
    Authorization: `Bearer ${DBX_TOKEN}`,
    "Content-Type": "application/json",
};
const clean = (s) => (s || "Unknown").replace(/[\\/:*?"<>|]/g, "_");

/* ───── helpers ───── */
async function createCCJob(v) {
    const r = await axios.post(`${CC_API}/jobs`, ccJobBody(v), {
        headers: CC_HDR,
    });
    return r.data.data.id;
}

async function dbxSave(fullPath, url, attempt = 0) {
    const r = await fetch("https://api.dropboxapi.com/2/files/save_url", {
        method: "POST",
        headers: dbxHeaders,
        body: JSON.stringify({ path: fullPath, url }),
    });
    if ([429, 503].includes(r.status) && attempt < 4) {
        const wait = 1000 * 2 ** attempt; // 1 s→2 s→4 s→8 s
        await new Promise((res) => setTimeout(res, wait));
        return dbxSave(fullPath, url, attempt + 1);
    }
    const js = await r.json();
    if (!r.ok) throw new Error(`save_url ${r.status}: ${JSON.stringify(js)}`);
    return js.async_job_id;
}

async function dbxCheck(id) {
    const r = await fetch("https://api.dropboxapi.com/2/files/save_url/check_job_status", {
        method: "POST",
        headers: dbxHeaders,
        body: JSON.stringify({ async_job_id: id }),
    });
    if (!r.ok) throw new Error(`check_job ${r.status}`);
    return await r.json();
}

/* ───── EXPORTS ───── */
export async function queueMissingExports() {
    const { videos } = await initDB();
    const q = {
        download_url: { $exists: true },
        stored: { $ne: true },
        $or: [{ cc_job_id: { $exists: false } }, { cc_status: "error" }],
    };
    let queued = 0;
    for await (const v of videos.find(q)) {
        try {
            const id = await createCCJob(v);
            await videos.updateOne(
                { video_id: v.video_id },
                {
                    $set: {
                        cc_job_id: id,
                        cc_status: "queued",
                        updated_at: new Date(),
                    },
                }
            );
            queued++;
        } catch (e) {
            await videos.updateOne(
                { video_id: v.video_id },
                {
                    $set: {
                        cc_status: "error",
                        cc_error: e.message,
                        updated_at: new Date(),
                    },
                }
            );
        }
    }
    return queued;
}

export async function pollStatuses() {
    const { videos } = await initDB();

    for await (const v of videos.find({ stored: { $ne: true } })) {
        /* A. CloudConvert */
        if (v.cc_job_id && !v.export_url) {
            const job = await axios.get(`${CC_API}/jobs/${v.cc_job_id}?include=tasks`, { headers: CC_HDR });
            const s = job.data.data.status;
            const upd = { cc_status: s, updated_at: new Date() };

            if (s === "finished") {
                const t = job.data.data.tasks.find((t) => t.operation === "export/url");
                upd.export_url = t?.result?.files?.[0]?.url;
            } else if (s === "error") {
                const err = job.data.data.tasks.find((t) => t.status === "error");
                upd.cc_error = err?.result?.message || "unknown";
            }
            await videos.updateOne({ video_id: v.video_id }, { $set: upd });
            continue;
        }

        /* B. start Dropbox save_url */
        if (v.export_url && !v.dropbox_job_id && v.dropbox_status !== "failed") {
            try {
                const lang = v.language ? `/${clean(v.language)}` : "";
                const path = `${ROOT}${lang}/${v.video_id}.mp4`;
                const id = await dbxSave(path, v.export_url);
                await videos.updateOne(
                    { video_id: v.video_id },
                    {
                        $set: {
                            dropbox_job_id: id,
                            dropbox_status: "in_progress",
                            updated_at: new Date(),
                        },
                    }
                );
            } catch (e) {
                await videos.updateOne(
                    { video_id: v.video_id },
                    {
                        $set: {
                            dropbox_status: "error",
                            dropbox_error: e.message,
                            updated_at: new Date(),
                        },
                    }
                );
            }
            continue;
        }

        /* C. poll Dropbox */
        if (v.dropbox_job_id && !["complete", "failed"].includes(v.dropbox_status)) {
            try {
                const res = await dbxCheck(v.dropbox_job_id);

                if (!res?.[".tag"]) {
                    await videos.updateOne(
                        { video_id: v.video_id },
                        {
                            $set: {
                                dropbox_status: "error",
                                dropbox_error: `malformed: ${JSON.stringify(res)}`,
                                updated_at: new Date(),
                            },
                        }
                    );
                    continue;
                }

                switch (res[".tag"]) {
                    case "in_progress":
                        break; // keep polling

                    case "failed": {
                        /* store ENTIRE failure object so we never lose the reason */
                        const failObj = res.failed || {};
                        const reason = failObj.reason?.[".tag"] || failObj[".tag"] || "unknown";
                        await videos.updateOne(
                            { video_id: v.video_id },
                            {
                                $set: {
                                    dropbox_status: "failed",
                                    dropbox_error: reason,
                                    dropbox_failure: failObj, // <‑‑ for inspection in logs UI
                                    updated_at: new Date(),
                                },
                            }
                        );

                        /* 🔄  auto‑recovery cases  */
                        if (reason === "conflict") {
                            /* file exists – try again with a timestamp suffix */
                            const newName = `${v.video_id}-${Date.now()}.mp4`;
                            const lang = v.language ? `/${clean(v.language)}` : "";
                            const newPath = `${ROOT}${lang}/${newName}`;
                            try {
                                const newId = await dbxSave(newPath, v.export_url);
                                await videos.updateOne(
                                    { video_id: v.video_id },
                                    {
                                        $set: {
                                            dropbox_job_id: newId,
                                            dropbox_status: "in_progress",
                                            dropbox_error: null,
                                            updated_at: new Date(),
                                        },
                                    }
                                );
                            } catch (e) {
                                /* leave as failed – will show real message now */
                            }
                        } else if (reason === "too_many_write_operations") {
                            /* rate‑limit – back off 30 s then re‑queue same job id */
                            setTimeout(() => {
                                videos.updateOne({ video_id: v.video_id }, { $set: { dropbox_status: "in_progress" } });
                            }, 30_000);
                        }
                        break;
                    }

                    case "complete": {
                        /* metadata is sometimes missing; fall back to full path we used */
                        const pathDisp =
                            res.complete?.metadata?.path_display ||
                            res.complete?.path_display ||
                            res.complete?.metadata?.path_lower ||
                            v.dropbox_full_path || // not yet set
                            "";
                        const finalPath = pathDisp || `${ROOT}/${clean(v.language)}/${v.video_id}.mp4`;
                        const finalUrl = `https://www.dropbox.com/home${encodeURIComponent(finalPath.startsWith("/") ? finalPath : `/${finalPath}`)}`;

                        await videos.updateOne(
                            { video_id: v.video_id },
                            {
                                $set: {
                                    dropbox_status: "complete",
                                    dropbox_path: finalPath,
                                    dropbox_url: finalUrl,
                                    stored: true,
                                    stored_at: new Date(),
                                },
                            }
                        );
                        break;
                    }
                }
            } catch (e) {
                await videos.updateOne(
                    { video_id: v.video_id },
                    {
                        $set: {
                            dropbox_status: "error",
                            dropbox_error: e.message,
                            updated_at: new Date(),
                        },
                    }
                );
            }
        }
    }
}
