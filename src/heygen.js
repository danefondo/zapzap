import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const heygen = axios.create({
    baseURL: "https://api.heygen.com",
    headers: {
        "X-API-Key": process.env.HEYGEN_API_KEY,
        "Content-Type": "application/json",
    },
    timeout: 30000,
});

export async function listVideos(token) {
    console.log("Making request to /v1/video.list with token:", token ? "present" : "none");
    try {
        let url = "/v1/video.list?limit=100";
        if (token) url += `&token=${token}`;
        const res = await heygen.get(url);
        return res.data.data; // { videos: [...], token }
    } catch (error) {
        console.error("HeyGen API error:", error.response?.status, error.response?.data);
        throw error;
    }
}

export async function getTranslatedVideo(videoId) {
    const res = await heygen.get(`/v2/video_translate/${videoId}`);
    return res.data.data; // contains .url
}
