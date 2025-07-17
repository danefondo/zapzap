import axios from "axios";
import fetch from "node-fetch";
import { initDB } from "../db.js";
import dotenv from "dotenv";
dotenv.config();

const CC_API = "https://api.cloudconvert.com/v2";
const HEADERS_CC = {
    Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}`,
    "Content-Type": "application/json",
};

const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const DROPBOX_FOLDER = (process.env.DROPBOX_FOLDER || "/HeyGenVideos/").replace(/\/+$/, "");

// 1. Build CloudConvert job (import/url ➜ export/url)
function buildJob(video) {
    const filename = `${video.video_id}.mp4`;
    return {
        tasks: {
            "import-url": {
                operation: "import/url",
                url: video.download_url,
                filename,
            },
            "export-url": {
                operation: "export/url",
                input: "import-url",
            },
        },
    };
}

async function createCCJob(video) {
    try {
        const res = await axios.post(`${CC_API}/jobs`, buildJob(video), { headers: HEADERS_CC });
        console.log("Created CC job", res.data.data.id, "for", video.video_id);
        return res.data.data.id;
    } catch (err) {
        console.error("CloudConvert job creation failed", err.response?.data || err.message);
        throw err;
    }
}

// 2. Dropbox save_url helpers
async function dropboxSaveUrl(filename, url) {
    const res = await fetch("https://content.dropboxapi.com/2/files/save_url", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${DROPBOX_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: `${DROPBOX_FOLDER}/${filename}`, url }),
    });
    if (!res.ok) throw new Error(`Dropbox save_url ${res.status}`);
    return (await res.json()).async_job_id;
}

async function dropboxCheck(jobId) {
    const res = await fetch("https://content.dropboxapi.com/2/files/save_url/check_job_status", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${DROPBOX_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ async_job_id: jobId }),
    });
    if (!res.ok) throw new Error(`Dropbox check ${res.status}`);
    return await res.json();
}

// 3. Queue CC + Dropbox
export async function queueMissingExports() {
    const { videos } = await initDB();
    const cursor = videos.find({ download_url: { $exists: true }, stored: { $ne: true }, cc_job_id: { $exists: false } });
    let queued = 0;
    for await (const vid of cursor) {
        try {
            const jobId = await createCCJob(vid);
            await videos.updateOne({ video_id: vid.video_id }, { $set: { cc_job_id: jobId, cc_status: "queued", updated_at: new Date() } });
            queued += 1;
        } catch (e) {
            await videos.updateOne({ video_id: vid.video_id }, { $set: { cc_status: "error", cc_error: e.message } });
        }
    }
    return queued;
}

export async function pollStatuses() {
    const { videos } = await initDB();
    const cursor = videos.find({ stored: { $ne: true } });
    for await (const vid of cursor) {
        // 3a. Handle CloudConvert side
        if (vid.cc_job_id && !vid.export_url) {
            const job = await axios.get(`${CC_API}/jobs/${vid.cc_job_id}?include=tasks`, { headers: HEADERS_CC });
            const status = job.data.data.status;
            const update = { cc_status: status, updated_at: new Date() };
            if (status === "finished") {
                const fileUrl = job.data.data.tasks.find((t) => t.name === "exportFile").result.files[0].url;
                update.export_url = fileUrl;
            } else if (status === "error") {
                const errTask = job.data.data.tasks.find((t) => t.status === "error");
                update.cc_error = errTask?.result?.message || "unknown";
            }
            await videos.updateOne({ video_id: vid.video_id }, { $set: update });
            continue; // process next video; Dropbox step next poll cycle
        }

        // 3b. If export_url exists but not yet in Dropbox
        if (vid.export_url && !vid.dropbox_job_id) {
            try {
                const jobId = await dropboxSaveUrl(`${vid.video_id}.mp4`, vid.export_url);
                await videos.updateOne({ video_id: vid.video_id }, { $set: { dropbox_job_id: jobId, dropbox_status: "in_progress", updated_at: new Date() } });
            } catch (err) {
                await videos.updateOne({ video_id: vid.video_id }, { $set: { dropbox_status: "error", dropbox_error: err.message } });
            }
            continue;
        }

        // 3c. Poll Dropbox job
        if (vid.dropbox_job_id && vid.dropbox_status !== "complete") {
            try {
                const res = await dropboxCheck(vid.dropbox_job_id);
                if (res[".tag"] === "in_progress") {
                    /* keep waiting */
                } else if (res[".tag"] === "failed") {
                    await videos.updateOne({ video_id: vid.video_id }, { $set: { dropbox_status: "failed", dropbox_error: res.failed.reason[".tag"] } });
                } else if (res[".tag"] === "complete") {
                    await videos.updateOne({ video_id: vid.video_id }, { $set: { dropbox_status: "complete", stored: true, stored_at: new Date(), dropbox_path: res.complete.metadata.path_display } });
                }
            } catch (err) {
                await videos.updateOne({ video_id: vid.video_id }, { $set: { dropbox_status: "error", dropbox_error: err.message } });
            }
        }
    }
}
