import { initDB } from "./db.js";

/**
 * writeLog(type, msg, meta?)
 *   type : 'info' | 'warn' | 'error'
 *   msg  : short human string
 *   meta : optional arbitrary object (stored verbatim)
 */
export async function writeLog(type, message, meta = {}) {
    try {
        const { db } = await initDB();
        await db.collection("logs").insertOne({
            ts: new Date(),
            type,
            message,
            ...meta,
        });
    } catch (e) {
        // logging must never crash the caller – just dump to console
        console.error("‼️ logger failed", e);
    }
}
