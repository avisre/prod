// AppSumo daily watch — monitor page metrics, redemptions, and funnel events.
// Usage: node scripts/appsumo-watch.js
// Rerunnable idempotent script that diffs against previous state.
const path = require('path');
const fs = require('fs');

const BACKEND = '/home/hardoker77/Downloads/new/prod-main/backend';
const STATE_FILE = path.join(__dirname, '.appsumo-watch-state.json');
const APPSUMO_URL = 'https://appsumo.com/products/stockportfoliopro/';

require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, 'prod.env') });
const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));

// Load previous state or initialize
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.warn('⚠️  Failed to load state file:', e.message);
      return null;
    }
  }
  return null;
}

// Save state to file
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Fetch AppSumo page and extract metrics
async function fetchAppSumoMetrics() {
  try {
    const response = await fetch(APPSUMO_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    });

    if (!response.ok) {
      console.warn(`⚠️  AppSumo page fetch failed with status ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Extract review_count (e.g., "review_count":42)
    const reviewCountMatch = html.match(/"review_count"\s*:\s*(\d+)/);
    const reviewCount = reviewCountMatch ? parseInt(reviewCountMatch[1], 10) : null;

    // Extract review_count_N_tacos values (1-5 star counts)
    const tacosCounts = {};
    for (let i = 1; i <= 5; i++) {
      const match = html.match(new RegExp(`"review_count_${i}_tacos"\\s*:\\s*(\\d+)`));
      if (match) {
        tacosCounts[i] = parseInt(match[1], 10);
      }
    }

    // Extract Q&A count (if present)
    const qaCountMatch = html.match(/"questions_count"\s*:\s*(\d+)/);
    const qaCount = qaCountMatch ? parseInt(qaCountMatch[1], 10) : null;

    if (reviewCount === null) {
      console.warn('⚠️  Could not extract review_count from AppSumo page');
      return null;
    }

    return {
      timestamp: new Date().toISOString(),
      reviewCount,
      tacosCounts,
      qaCount,
      pageReachable: true,
    };
  } catch (err) {
    console.warn(`⚠️  AppSumo page fetch error: ${err.message}`);
    return null;
  }
}

// Query MongoDB for AppSumo and funnel data
async function fetchDBMetrics() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;

  // Find AppSumo license collection
  const cols = (await db.listCollections().toArray()).map((c) => c.name);
  const licCol = cols.find((c) => /appsumo/i.test(c));

  let licenseMetrics = { total: 0, redeemed: 0 };
  if (licCol) {
    const L = db.collection(licCol);
    licenseMetrics.total = await L.countDocuments();
    licenseMetrics.redeemed = await L.countDocuments({ redeemedAt: { $ne: null } });
  }

  // Count users with appsumoLicenseKey
  const users = db.collection('users');
  const usersWithLicense = await users.countDocuments({ appsumoLicenseKey: { $ne: null } });

  // Count funnel events
  let funnelCounts = {};
  const funnelCol = db.collection('funnel_events');
  if (funnelCol) {
    const results = await funnelCol.aggregate([
      { $group: { _id: '$event', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();

    results.forEach((r) => {
      funnelCounts[r._id || 'unknown'] = r.count;
    });
  }

  await mongoose.disconnect();

  return {
    timestamp: new Date().toISOString(),
    licenses: licenseMetrics,
    usersWithLicense,
    funnelEvents: funnelCounts,
  };
}

// Generate diff report
function generateDiffReport(prev, current) {
  const lines = [];
  lines.push('📊 CHANGES SINCE LAST RUN:');

  if (!prev) {
    lines.push('  (first run — baseline established)');
    return lines.join('\n');
  }

  // AppSumo page metrics
  if (prev.page && current.page) {
    if (prev.page.reviewCount !== current.page.reviewCount) {
      const delta = current.page.reviewCount - prev.page.reviewCount;
      lines.push(`  🆕 ${Math.abs(delta)} ${delta > 0 ? 'new' : 'removed'} review(s) (${prev.page.reviewCount}→${current.page.reviewCount})`);
    }

    // Check individual taco counts for new reviews
    if (prev.page.tacosCounts && current.page.tacosCounts) {
      for (let i = 1; i <= 5; i++) {
        const prevTacos = prev.page.tacosCounts[i] || 0;
        const currTacos = current.page.tacosCounts[i] || 0;
        if (currTacos > prevTacos) {
          lines.push(`  ⭐ +${currTacos - prevTacos} ${i}-star review(s)`);
        }
      }
    }

    if (prev.page.qaCount !== undefined && current.page.qaCount !== undefined) {
      if (prev.page.qaCount !== current.page.qaCount) {
        const delta = current.page.qaCount - prev.page.qaCount;
        lines.push(`  ❓ ${Math.abs(delta)} ${delta > 0 ? 'new' : 'removed'} Q&A (${prev.page.qaCount}→${current.page.qaCount})`);
      }
    }
  }

  // License metrics
  if (prev.db && current.db) {
    if (prev.db.licenses.total !== current.db.licenses.total) {
      const delta = current.db.licenses.total - prev.db.licenses.total;
      lines.push(`  🆕 ${delta} new license(s) (${prev.db.licenses.total}→${current.db.licenses.total})`);
    }
    if (prev.db.licenses.redeemed !== current.db.licenses.redeemed) {
      const delta = current.db.licenses.redeemed - prev.db.licenses.redeemed;
      lines.push(`  ✅ ${delta} new redemption(s) (${prev.db.licenses.redeemed}→${current.db.licenses.redeemed})`);
    }
    if (prev.db.usersWithLicense !== current.db.usersWithLicense) {
      const delta = current.db.usersWithLicense - prev.db.usersWithLicense;
      lines.push(`  👤 ${delta} new user(s) with license (${prev.db.usersWithLicense}→${current.db.usersWithLicense})`);
    }
  }

  // Funnel events
  if (prev.db && current.db && prev.db.funnelEvents && current.db.funnelEvents) {
    const eventTypes = ['page_view', 'signup', 'trial_start', 'paid', 'cancel'];
    for (const evt of eventTypes) {
      const prevCount = prev.db.funnelEvents[evt] || 0;
      const currCount = current.db.funnelEvents[evt] || 0;
      if (currCount > prevCount) {
        lines.push(`  📈 +${currCount - prevCount} ${evt}(s) (${prevCount}→${currCount})`);
      }
    }
  }

  if (lines.length === 1) {
    lines.push('  (no changes)');
  }

  return lines.join('\n');
}

// Generate draft reply stubs for new reviews
function generateReplyStubs(prev, current) {
  if (!prev || !prev.page || !current.page) {
    return '';
  }

  const lines = [];

  if (prev.page.reviewCount < current.page.reviewCount) {
    const newReviewCount = current.page.reviewCount - prev.page.reviewCount;
    lines.push('');
    lines.push('💬 DRAFT REPLY STUBS (for new reviews):');
    for (let i = 0; i < newReviewCount; i++) {
      lines.push('');
      lines.push(`  --- Review #${prev.page.reviewCount + i + 1} ---`);
      lines.push('  Thanks for the review! We appreciate your feedback. If you have any questions or need help, feel free to reach out.');
    }
  }

  if (prev.page.qaCount && current.page.qaCount && prev.page.qaCount < current.page.qaCount) {
    const newQACount = current.page.qaCount - prev.page.qaCount;
    lines.push('');
    lines.push('❓ DRAFT REPLY STUBS (for new Q&A):');
    for (let i = 0; i < newQACount; i++) {
      lines.push('');
      lines.push(`  --- Q&A #${prev.page.qaCount + i + 1} ---`);
      lines.push("  Thanks for your question! We're here to help. Please let me know if you need any additional information.");
    }
  }

  return lines.join('\n');
}

// Main execution
(async () => {
  const startTime = new Date();
  console.log(`\n🔍 AppSumo Watch — ${startTime.toISOString()}\n`);

  // Fetch current metrics
  console.log('Fetching AppSumo page metrics...');
  const pageMetrics = await fetchAppSumoMetrics();

  console.log('Connecting to database...');
  let dbMetrics;
  try {
    dbMetrics = await fetchDBMetrics();
  } catch (err) {
    console.error('Database connection failed:', String(err).slice(0, 200));
    process.exit(1);
  }

  // Combine current state
  const current = {
    page: pageMetrics,
    db: dbMetrics,
  };

  // Load previous state
  const prev = loadState();

  // Print diff report
  console.log('\n' + generateDiffReport(prev, current));

  // Print reply stubs if applicable
  const stubs = generateReplyStubs(prev, current);
  if (stubs) {
    console.log(stubs);
  }

  // Print summary
  console.log('\n📋 CURRENT SNAPSHOT:');
  if (pageMetrics && pageMetrics.pageReachable) {
    console.log(`  AppSumo page: ${pageMetrics.reviewCount} reviews`);
    if (pageMetrics.qaCount !== null) {
      console.log(`  Q&A count: ${pageMetrics.qaCount}`);
    }
  } else {
    console.log('  AppSumo page: unreachable / fields not found');
  }

  if (dbMetrics) {
    console.log(`  Licenses: ${dbMetrics.licenses.total} total, ${dbMetrics.licenses.redeemed} redeemed`);
    console.log(`  Users with license: ${dbMetrics.usersWithLicense}`);
    console.log(`  Funnel events: ${JSON.stringify(dbMetrics.funnelEvents)}`);
  }

  const endTime = new Date();
  console.log(`\n✅ Complete at ${endTime.toISOString()} (${endTime - startTime}ms)\n`);

  // Save current state
  saveState(current);
  console.log(`State saved to ${STATE_FILE}`);
})().catch((e) => {
  console.error('Fatal error:', String(e).slice(0, 300));
  process.exit(1);
});
