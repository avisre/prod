#!/usr/bin/env node
'use strict';

// Manual post-payment corpus delivery. NOT self-serve, by design.
//
//   node scripts/generate-corpus-download.js --buyer name@example.com --expires 7d \
//        --source /path/to/corpus-export [--dry-run]
//
// Steps: tar.gz the export directory, PUT it to S3, and print a signed GET URL
// that expires. A person runs this once, after the payment has cleared.
//
// Requires in the environment (see docs/growth/corpus-license-terms.md):
//   CORPUS_S3_BUCKET, CORPUS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//   (optional AWS_SESSION_TOKEN)
//
// Signing is plain SigV4 over node:crypto — no SDK dependency is added for
// what amounts to two requests. --dry-run does the packaging and prints the
// signed URL it *would* issue without uploading anything, which is how this is
// tested without real credentials.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const MAX_EXPIRY_SECONDS = 7 * 86400; // S3's own hard ceiling for a signed URL

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        if (key === 'dry-run') { out.dryRun = true; continue; }
        out[key] = argv[i + 1];
        i += 1;
    }
    return out;
}

// "7d" / "36h" / "3600" -> seconds
function parseExpiry(raw) {
    const m = /^(\d+)\s*([dhms]?)$/i.exec(String(raw || '').trim());
    if (!m) throw new Error('--expires must look like 7d, 36h, 90m or a number of seconds');
    const n = Number(m[1]);
    const mult = { d: 86400, h: 3600, m: 60, s: 1, '': 1 }[m[2].toLowerCase()];
    const seconds = n * mult;
    if (seconds < 60) throw new Error('--expires must be at least 60 seconds');
    if (seconds > MAX_EXPIRY_SECONDS) throw new Error(`--expires cannot exceed 7d (S3 signed-URL maximum)`);
    return seconds;
}

// A buyer-specific, non-guessable key. The email is hashed, never placed in the
// object key — the URL gets shared and forwarded, and it should not carry the
// buyer's address around with it.
function objectKey(buyerEmail, stamp) {
    const tag = crypto.createHash('sha256').update(String(buyerEmail).toLowerCase()).digest('hex').slice(0, 12);
    return `corpus/${stamp}/${tag}/stockportfolio-corpus-${stamp}.tar.gz`;
}

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key) => key.split('/').map(uriEncode).join('/');

function signingKey(secret, dateStamp, region, service) {
    return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}

function amzStamps(now = new Date()) {
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Presigned GET (query-string SigV4). */
function presignGet({ bucket, region, key, expiresIn, accessKeyId, secretAccessKey, sessionToken, now }) {
    const host = `${bucket}.s3.${region}.amazonaws.com`;
    const { amzDate, dateStamp } = amzStamps(now);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const params = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${accessKeyId}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(expiresIn),
        'X-Amz-SignedHeaders': 'host'
    };
    if (sessionToken) params['X-Amz-Security-Token'] = sessionToken;
    const canonicalQuery = Object.keys(params).sort().map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`).join('&');
    const canonicalRequest = ['GET', `/${encodeKey(key)}`, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const signature = hmac(signingKey(secretAccessKey, dateStamp, region, 's3'), stringToSign).toString('hex');
    return `https://${host}/${encodeKey(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Signed PUT (header SigV4) for the upload itself. */
function signedPutHeaders({ bucket, region, key, body, accessKeyId, secretAccessKey, sessionToken, now }) {
    const host = `${bucket}.s3.${region}.amazonaws.com`;
    const { amzDate, dateStamp } = amzStamps(now);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const payloadHash = sha256hex(body);
    const headers = {
        host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {})
    };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join('');
    const canonicalRequest = ['PUT', `/${encodeKey(key)}`, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const signature = hmac(signingKey(secretAccessKey, dateStamp, region, 's3'), stringToSign).toString('hex');
    return {
        host,
        headers: {
            ...headers,
            'content-length': body.length,
            'content-type': 'application/gzip',
            authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
        }
    };
}

function putObject({ host, key, headers, body }) {
    return new Promise((resolve, reject) => {
        const req = https.request({ method: 'PUT', host, path: `/${encodeKey(key)}`, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300
                ? resolve()
                : reject(new Error(`S3 upload failed (${res.statusCode}): ${Buffer.concat(chunks).toString('utf8').slice(0, 500)}`))));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function packageExport(sourceDir, stamp) {
    const dir = path.resolve(sourceDir);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
        throw new Error(`${dir} does not look like a corpus export (no manifest.json). Run scripts/export-corpus.js first.`);
    }
    const archive = path.join(path.dirname(dir), `stockportfolio-corpus-${stamp}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', path.dirname(dir), path.basename(dir)]);
    return archive;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const buyer = String(args.buyer || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(buyer)) throw new Error('--buyer <email> is required');
    const expiresIn = parseExpiry(args.expires || '7d');
    const source = args.source || './corpus-export';

    const stamp = new Date().toISOString().slice(0, 10);
    const archive = packageExport(source, stamp);
    const body = fs.readFileSync(archive);
    const key = objectKey(buyer, stamp);

    const cfg = {
        bucket: process.env.CORPUS_S3_BUCKET,
        region: process.env.CORPUS_S3_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN || null
    };
    const missing = ['bucket', 'region', 'accessKeyId', 'secretAccessKey'].filter((k) => !cfg[k]);
    if (missing.length && !args.dryRun) {
        throw new Error(`Missing S3 configuration: ${missing.join(', ')}. Set CORPUS_S3_BUCKET, CORPUS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (or pass --dry-run).`);
    }

    if (args.dryRun) {
        console.log(JSON.stringify({
            dryRun: true, buyer, archive, bytes: body.length, key,
            expiresIn, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
            s3Configured: missing.length === 0,
            note: 'Nothing was uploaded and no link was issued. Email the URL to the buyer yourself — this script does not send mail.'
        }, null, 2));
        return;
    }

    const put = signedPutHeaders({ ...cfg, key, body });
    await putObject({ host: put.host, key, headers: put.headers, body });
    const url = presignGet({ ...cfg, key, expiresIn });

    console.log(JSON.stringify({
        buyer, key, bytes: body.length,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        url,
        next: 'Email this URL to the buyer with the licence terms. This script deliberately does not send it.'
    }, null, 2));
}

module.exports = { parseExpiry, objectKey, presignGet, signedPutHeaders };

if (require.main === module) {
    main().catch((error) => { console.error(error && error.message || error); process.exit(1); });
}
