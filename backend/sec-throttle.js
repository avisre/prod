// Global SEC rate limiter. SEC EDGAR's fair-access policy is 10 requests/second
// per IP; exceed it and the IP is temporarily blocked (the 429 that silently
// emptied dossier sections in the 50-stock sweep). We cap ourselves at 8/sec
// with a token bucket, installed as an axios request interceptor on the default
// instance — so EVERY outbound call to *.sec.gov across the whole codebase
// (sec-source, filing-fetcher, watchdog, insiders, gurus, segments, keypoints,
// ai-chat) is paced automatically, with no per-call-site changes and covering
// any future SEC call too. A small burst (capacity 8) keeps a single dossier's
// handful of fetches instant; sustained load (pre-warm, bursts) is held to 8/sec.

const axios = require('axios');

const RATE = 8;   // tokens refilled per second (under SEC's 10/s ceiling)
const CAP = 1;    // evenly paced: no burst above the rolling SEC ceiling
let tokens = CAP;
let lastRefill = Date.now();
let chain = Promise.resolve(); // serializes token accounting (race-free)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function refill() {
    const now = Date.now();
    tokens = Math.min(CAP, tokens + ((now - lastRefill) / 1000) * RATE);
    lastRefill = now;
}

// Acquire one SEC request slot, waiting if the bucket is empty.
function take() {
    const p = chain.then(async () => {
        const conn=require('mongoose').connection;
        if(conn.readyState===1) {
            // One shared slot allocator across production processes/instances.
            // Only public rate metadata; no user/account collections.
            const col=conn.collection('public_financial_rate_limits');
            await col.updateOne({_id:'sec'},{$setOnInsert:{nextSlotAt:new Date(0)}},{upsert:true});
            for(let attempt=0;attempt<240;attempt++) {
                const now=new Date();
                const acquired=await col.findOneAndUpdate({_id:'sec',nextSlotAt:{$lte:now}},{$set:{nextSlotAt:new Date(now.getTime()+125)}},{returnDocument:'after'});
                if(acquired)return;
                await sleep(125);
            }
            throw new Error('SEC_COORDINATED_RATE_LIMIT_BUSY');
        }
        if(process.env.NODE_ENV==='production' && process.env.MONGODB_URI)throw new Error('SEC_SHARED_RATE_LIMIT_UNAVAILABLE');
        refill();
        if (tokens >= 1) { tokens -= 1; return; }
        const waitMs = Math.ceil(((1 - tokens) / RATE) * 1000);
        await sleep(waitMs);
        refill();
        tokens = Math.max(0, tokens - 1);
    });
    chain = p.catch(() => {}); // keep the queue alive on any error
    return p;
}

const SEC_HOST = /(^|\.)sec\.gov$/i;
let installed = false;
function install() {
    if (installed) return;
    installed = true;
    axios.interceptors.request.use(async (config) => {
        let isSec=false;
        try {
            const raw = config.url || '';
            const u = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw, config.baseURL || 'https://invalid.local');
            isSec=SEC_HOST.test(u.hostname);
        } catch (_) { /* never block a request on a parse error */ }
        if(isSec)await take();
        return config;
    });
}

install();

module.exports = { take, install, stats: () => ({ tokens: Math.floor(tokens), rate: RATE, cap: CAP }) };
