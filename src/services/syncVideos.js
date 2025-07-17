// fetch TRANSLATED videos + language + download URL, store in Mongo
import axios from "axios";
import { initDB } from "../db.js";
import dotenv from "dotenv";
dotenv.config();

/* default instance (env key) */
const HG_DEFAULT = axios.create({
    baseURL: "https://api.heygen.com",
    headers: { "x-api-key": process.env.HEYGEN_API_KEY },
    timeout: 20_000,
});

/**
 * syncTranslations(cutoffUnix = 0, apiKey = '')
 *  cutoffUnix … ignore videos older than this (0 = no cut‑off)
 *  apiKey     … optional HeyGen key from the client
 */
export async function syncTranslations(cutoffUnix = 0, apiKey = "") {
    /* if a client key is provided use it; else reuse the default instance */
    const HG = apiKey
        ? axios.create({
              baseURL: "https://api.heygen.com",
              headers: { "x-api-key": apiKey },
              timeout: 20_000,
          })
        : HG_DEFAULT;

    const { videos } = await initDB();
    let nextToken = null;
    let imported = 0;

    do {
        const params = { limit: 100 };
        if (nextToken) params.token = nextToken;

        const res = await HG.get("/v1/video.list", { params });
        if (res.data.code !== 100) throw new Error("HeyGen error " + res.data.code);

        for (const v of res.data.data.videos) {
            if (v.type !== "TRANSLATED") continue;
            if (cutoffUnix && v.created_at < cutoffUnix) continue;

            // pull language + direct MP4
            const tr = await HG.get(`/v2/video_translate/${v.video_id}`);
            const lang = tr.data.data.output_language || "Unknown";
            const url = tr.data.data.url;

            await videos.updateOne(
                { video_id: v.video_id },
                {
                    $set: {
                        video_id: v.video_id,
                        video_title: v.video_title,
                        created_at: v.created_at,
                        status: v.status,
                        language: lang,
                        download_url: url,
                        updated_at: new Date(),
                    },
                },
                { upsert: true }
            );
            imported++;
        }
        nextToken = res.data.data.token;
    } while (nextToken);

    console.log("🟢 Sync imported", imported);
    return imported;
}
