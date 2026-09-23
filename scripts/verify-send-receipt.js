#!/usr/bin/env node
'use strict';
// Wire canary, no recipient outside our own mailbox: send one message through
// backend/mailer.js (the exact module the app uses) from support@ to support@,
// then log in over IMAP and read the Message-ID off the message that actually
// arrived. If the id we stored equals the id on the delivered message, the
// receipt names the message rather than merely describing a send attempt.
//
//   node tmp-wire-canary.js
//
// Reads only: BODY.PEEK, so nothing gets marked \Seen. The one write is the
// self-addressed message itself.

const path = require('node:path');
const tls = require('node:tls');
require(path.join(__dirname, '../backend/node_modules', 'dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const mailer = require('../backend/mailer');

const HOST = process.env.SMTP_HOST || 'mail.privateemail.com';
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;

function imap(command, socket, tag) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    // Resolve on the tag line whatever its status: a BAD/NO must surface as a
    // readable error, not a 20-second hang that hides the server's reason.
    const done = new RegExp(`^${tag} (OK|NO|BAD)`, 'm');
    const timer = setTimeout(() => { socket.off('data', onData); reject(new Error(`timeout waiting for ${tag}: ${buffer.slice(-200)}`)); }, 20000);
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      if (done.test(buffer)) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve(buffer);
      }
    }
    socket.on('data', onData);
    socket.write(command + '\r\n');
  });
}

async function readNewestHeaders(sinceUid) {
  const socket = tls.connect({ host: HOST, port: 993, servername: HOST });
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });
  socket.setEncoding('utf8');
  await imap(`a1 LOGIN "${USER}" "${PASS}"`, socket, 'a1');
  // EXAMINE, not SELECT: read-only, so nothing is marked \Seen and \Recent is
  // left alone. A search issued without a selected mailbox is refused with
  // "a2 BAD No mailbox selected".
  await imap('a1b EXAMINE INBOX', socket, 'a1b');
  // UIDs start at 1 — a "0:*" range is rejected outright.
  const search = await imap('a2 UID SEARCH UID 1:*', socket, 'a2');
  if (!/^a2 OK/m.test(search)) throw new Error(`SEARCH failed: ${search.slice(-200)}`);
  const uids = (search.match(/\* SEARCH([^\r\n]*)/) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
  const wanted = String(process.argv[3] || '');
  const newest = uids.length ? uids[uids.length - 1] : null;
  let out = null;
  if (newest) {
    const fetch = await imap(
      `a3 UID FETCH ${newest} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT DATE TO)])`,
      socket, 'a3'
    );
    const messageId = (fetch.match(/Message-ID:\s*(<[^>]+>)/i) || [])[1] || null;
    const to = (fetch.match(/^To:.*$/im) || [])[0] || null;
    out = { uid: newest, messageId, to, matchedRequested: wanted ? messageId === wanted : null };
  }
  await imap('a4 LOGOUT', socket, 'a4').catch(() => {});
  socket.end();
  return out;
}

// Waits for a message to appear whose Message-ID is the one we recorded. The
// relay queues the message, so it can take longer than a few seconds to land —
// a single 4-second glance races delivery and reports a false mismatch.
async function waitForDelivered(messageId, attempts = 10, gapMs = 5000) {
  for (let i = 0; i < attempts; i++) {
    const arrived = await readNewestHeaders();
    if (!arrived) return null;
    if (!messageId || arrived.messageId === messageId) return arrived;
    if (i === attempts - 1) return arrived;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

async function main() {
  if (!USER || !PASS) throw new Error('SMTP_USER / SMTP_PASS are not set locally');

  // Read-only mode: no send, just answer "is this id on a delivered message?".
  // Used to close the loop on a message already sent without sending another.
  // It can only see OUR OWN mailbox, so it is meaningful for a self-addressed
  // canary — a customer's recorded id is delivered to THEIR inbox and will
  // correctly report no match here. That is not a failure of the receipt.
  if (process.argv[2] === '--check') {
    const wanted = String(process.argv[3] || '');
    if (!wanted) throw new Error('pass the Message-ID to look for');
    const arrived = await readNewestHeaders(wanted);
    console.log('newest in INBOX:', JSON.stringify(arrived, null, 1));
    console.log('\nVERDICT');
    console.log('  requested id        :', wanted);
    console.log('  newest delivered id :', arrived && arrived.messageId);
    console.log('  MATCH               :', Boolean(arrived && arrived.messageId === wanted));
    return;
  }

  const receipt = await mailer.sendMail({
    to: USER,
    subject: 'Receipt wire canary — internal, no action needed',
    text: 'Internal check that the Message-ID recorded in the send receipt is the Message-ID on the delivered message.'
  });
  if (!receipt) throw new Error('sendMail returned false — check SMTP config');
  console.log('receipt:', JSON.stringify(receipt, null, 1));

  const arrived = await waitForDelivered(receipt.messageId);
  console.log('arrived:', JSON.stringify(arrived, null, 1));

  console.log('\nVERDICT');
  console.log('  relay accepted      :', String(receipt.response || '').startsWith('250'));
  console.log('  messageId recorded  :', receipt.messageId);
  console.log('  messageId delivered :', arrived && arrived.messageId);
  console.log('  MATCH               :', Boolean(arrived && arrived.messageId === receipt.messageId));
}

main().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
