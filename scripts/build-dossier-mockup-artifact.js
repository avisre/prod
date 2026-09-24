#!/usr/bin/env node
/**
 * Builds the publishable copy of the dossier mockup from the single source
 * of truth, docs/design/dossier-panel.html.
 *
 * Two reasons this exists rather than a second hand-maintained file:
 *   - the source stays a standalone document (doctype + <html> + <head>) so it opens
 *     over file:// and headless Chrome can screenshot it with no server; the published
 *     copy must be a bare fragment, since the Artifact viewer supplies the skeleton.
 *   - an edit to the design is then one command away from a republish.
 *
 * Only three things change: the wrapper is dropped, the <title> becomes the artifact's
 * name, and a small extra block adds the phone safe-area insets to the design's one
 * fixed element. The design CSS itself is copied through untouched.
 *
 * NOTE: repointed from the rejected dossier-plain-filing.html on 2026-09-24. Publishing is
 * currently blocked in this environment (ANTHROPIC_AUTH_TOKEN overrides the claude.ai
 * account and the refusal says not to retry), so this has never been run against a live
 * artifact — it is here so the panel design, not the rejected one, is what a later session
 * republishes.
 *
 * Usage: node scripts/build-dossier-mockup-artifact.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'docs', 'design', 'dossier-panel.html');
const OUT = path.join(__dirname, '..', 'docs', 'design', 'dossier-panel.artifact.html');

const src = fs.readFileSync(SRC, 'utf8');

const styleOpen = src.indexOf('<style>');
const styleClose = src.indexOf('</style>');
if (styleOpen < 0 || styleClose < 0) throw new Error('no <style> block found in ' + SRC);
const style = src.slice(styleOpen, styleClose + '</style>'.length);

// The viewer supplies the skeleton, so anything the source kept in <head> has to be
// carried over explicitly or it is silently dropped. That is the whole font stack for
// this design — the identity is three typefaces, so losing them loses the design.
const head = src.slice(0, styleOpen);
const links = head.match(/<link\b[^>]*>/g) || [];
if (!links.length) throw new Error('no <link> tags found in the head of ' + SRC);

const bodyOpen = src.indexOf('<body');
if (bodyOpen < 0) throw new Error('no <body> found in ' + SRC);
const bodyStart = src.indexOf('>', bodyOpen) + 1;
const bodyEnd = src.lastIndexOf('</body>');
if (bodyEnd < 0) throw new Error('no </body> found in ' + SRC);
const body = src.slice(bodyStart, bodyEnd).trim();

// Publishing accommodations only — never design changes.
const SAFE_AREA = `<style>
/* Publishing-only: the viewer supplies the document skeleton, and its :root carries the
   phone's safe-area padding. A fixed element is positioned against the viewport, not that
   padding, so it needs the inset added explicitly. The slide-over is the only fixed
   element here — the mockup's own state bar sits inside the static .dp-chromebar, which
   is why this block no longer mentions a bar or an ask strip. */
.dp-slide { top: calc(var(--dp-chrome) + env(safe-area-inset-top, 0px)); bottom: env(safe-area-inset-bottom, 0px); }
@media (max-width: 1024px), (max-height: 760px) { .dp-slide { top: env(safe-area-inset-top, 0px); } }
</style>`;

const out = [
  '<title>Company Panel</title>',
  links.join('\n'),
  style,
  SAFE_AREA,
  body,
  '',
].join('\n');

fs.writeFileSync(OUT, out);
console.log(`${path.relative(process.cwd(), OUT)}  ${out.length} bytes`);
console.log('open it as: ' + OUT);
