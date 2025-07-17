import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

const client = new MongoClient(process.env.MONGO_URI, {
    maxPoolSize: 10,
});

export async function initDB() {
    if (!client.topology || !client.topology.isConnected()) await client.connect();
    const db = client.db();
    const videos = db.collection("videos");
    const logs = db.collection("logs");
    await videos.createIndex({ video_id: 1 }, { unique: true });
    await videos.createIndex({ created_at: -1 });
    await logs.createIndex({ ts: -1 });
    return { db, videos, logs };
}

export function getClient() {
    return client;
}
