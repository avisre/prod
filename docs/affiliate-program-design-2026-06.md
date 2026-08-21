# Affiliate Program Design — Stock Portfolio Pro (2026-06-19)

**Status:** Ready to implement. This design balances two motions (retail + high-ticket), costs <$200/mo to run solo, and outperforms paid ads for your niche.

---

## 1. Commission Structure with Benchmarks

### A. Retail Tiers (£9 Core / £25 Pro)

**Recommended: 30% recurring / 120-day cookie**

| Metric | Rate | Reasoning |
|---|---|---|
| **Commission per sale** | 30% recurring | Matches Finviz benchmark (verified 2026-06-14, rewardful.com). SaaS norm is 20–30%; you're at the top tier because: (a) 100% margin on AI tokens post-infrastructure, (b) high intent → high LTV users, (c) creators we target are proven monetizers (won't settle for <25%) |
| **Cookie duration** | 120 days | B2C research tools: research phase is 2–8 weeks; 90-day standard (Finviz, Stock Rover); add 30 days for decision-maker lag. Longer than 120 = fraud risk (accidental double-attribution) |
| **Tracking method** | Unique coupon code + UTM params OR Rewardful integration | See Section 2 |
| **Payment frequency** | Monthly (30 days after month-end) | Standard SaaS; matches Stripe payout cycle |
| **Minimum payout** | £50 per month (waive if cumulative >£200) | Avoids <$1 wire fees; aligns with your bank's cost |

**Why 30%, not 50% (Sharesight's max)?**
- Sharesight's 50% tier requires 10+ conversions/mo (they're locking out solo creators below that volume). You want solo creators.
- 30% on volume beats 50% on nobody. A creator with 100 annual clicks → ~2–3 conversions/mo at 40% CTR = £18–27/mo at 30%, vs £0 if the offer doesn't exist.
- Desk (high-ticket) will take the 25–30% margin pressure; retail absorbs the affiliate cost.

### B. High-Ticket Tier (Power £440 / Desk £1,490/yr)

**Recommended: 30% recurring / 120-day cookie (same structure, same cost-per-customer)**

| Metric | Rate | Reasoning |
|---|---|---|
| **Commission per sale** | 30% recurring | £447 per Desk customer per year (~£37/mo). Even at "high-ticket should drop to 15–25%" rule, £447 is 2–3x what most creators earn on a single partner. Creators will move for this. |
| **Cookie duration** | 120 days | Desk buyer (analyst, RIA) has longer research cycle; 120 days is prudent. No data on competitor B2B cycles; 90-min safe floor. |
| **Upfront vs. recurring** | Recurring, billing-synced | Power/Desk bill upfront annually. Pay affiliate on the invoice date (when you get the cash), not first charge of a trial. |
| **Two-tier approach for traction** | Offer affiliate OR flat-fee sponsorship, not both | The Bear Cave (Edwin Dorsey) would take a CPA deal: "$500 flat + $100 per Desk signup" beats a flat $1,500 sponsorship. You decide per partner — don't do both for one. |

**Total affiliate cost projection (year 1, reaching 20–30 customers):**
- 20 retail @ £9/mo avg = £216/mo revenue; 30% affiliate share = £65/mo (spread across 5–8 creators)
- 5 Desk @ £1,490/yr = £7,450/yr; 30% = £2,235/yr (£186/mo, concentrated in 2–3 high-performing partners)
- **Total: ~£250/mo year 1 → feasible without hurting unit economics**

---

## 2. Tracking Systems: Solo Founder Options

### Option A: Manual Coupon Codes (Stripe + Spreadsheet)

**Setup:** Create unique Stripe coupon for each creator. Track signups in tracker.md. Pay manually at month-end.

| Pros | Cons |
|---|---|
| **Zero cost**, free Stripe | **No attribution if signup fails** → customer forgets code, uses organic link instead |
| **Full control** — you see customer email, can ask "where'd you find us" | **Manual payment** every month (30 minutes) |
| **Easy to adjust** — pause a creator mid-month if they go dark | **Cookie-less** — no 120-day window; only counts code usage |
| | **Scale friction** — 20+ creators = unmaintainable spreadsheet |

**When to use:** NOW, for next 4–6 weeks. Founders 0–20 customers. Fast path to validate affiliate channel works.

**How:** 
```
1. Create coupon: Stripe Dashboard → Coupons → Fixed amount (£0.01) or %
   - Name: "TOM_INVESTING_Q3" (creator_channel)
   - Limit: none (codes can be reused)
   - Expiry: set to 1 year
2. Email creator with code + unique landing link (e.g., register.html?code=TOM_INVESTING)
3. Every signup using code = commission earned
4. Manual payment: Stripe → Payouts, log who owes what in tracker.md, send via bank transfer
```

**Gotchas:**
- Coupon stacking: if a customer applies multiple codes, only the first works. Stripe doesn't show attribution.
- You'll manually verify each payout (email the creator: "You had X signups this month using your code"). Transparent, but slow.
- Spreadsheet gets messy at >10 creators. Move to Rewardful at that point.

---

### Option B: Rewardful (Premium: Zapier-owned, ~$99/mo)

**Setup:** Integrate Stripe → Rewardful. Assign unique referral links to each creator. Automatic affiliate payouts.

| Pros | Cons |
|---|---|
| **Auto-attribution** — 120-day cookie window, handles trial-to-paid conversion seamlessly | **Cost:** $99–$499/mo (depending on payout volume) — only worth it at 30+ affiliates or $30k+ MRR |
| **No manual payment** — payouts go straight to creator's bank account | **Setup:** 2–3 hours (Stripe integration, dashboard config) |
| **Creator dashboard** — they see their own stats, encourages participation | **Learning curve:** Zapier workflows if you want custom logic (e.g., bonus tiers) |
| **Built-in fraud detection** — flags suspicious patterns | |
| **Scales to 200+ affiliates** — you're not the bottleneck | |

**When to use:** After 10+ active creators, or if you expect 30+ signups/mo from affiliates.

**Cost math:** At $99/mo flat + payment processing (Rewardful charges 2% on payouts), you're spending $120/mo to save 3–4 hours/mo. Breakeven at 10 active creators (£18+/mo each).

---

### Option C: FirstPromoter (~$49/mo for startups)

**Setup:** Lightweight affiliate platform. Simpler UI than Rewardful. Slack notifications.

| Pros | Cons |
|---|---|
| **Cheaper:** $49/mo tier covers up to 50 affiliates | **Less sophisticated:** no fraud detection, limited reporting |
| **Fast onboarding:** creators sign up self-service, get link + dashboard immediately | **Payout:** manual (you approve each payout) — no auto bank transfer |
| **Slack alerts:** every signup, every referral, real-time. Keeps you engaged. | **Limited integrations:** works with Stripe, but no Zapier native |
| **Perfect for solos:** designed for indie makers, not enterprise | |

**When to use:** After 5–10 creators, before Rewardful. Sweet spot for year 1.

---

### Option D: Tolt (Modern, Creator-First; ~$99/mo)

**Setup:** Referral SaaS built by indie founders. Focuses on crypto/SaaS.

| Pros | Cons |
|---|---|
| **Creator experience:** best-in-class dashboard, Stripe sync, auto-payouts | **Newer:** smaller community, fewer integration templates |
| **Pricing:** $99/mo for unlimited affiliates | **Overkill for 5–10 creators** — better at scale |
| **Recurring commission tracking:** handles trial-to-paid natively | **Setup:** ~1–2 hours |

**When to use:** Year 2, after validating affiliate channel works.

---

### Recommendation for Your Workflow

**Phase 1 (Weeks 1–6, 0–20 customers):** Manual coupon codes + spreadsheet.
- Cost: $0. Time: 30 min/mo.
- Test if creators actually close sales. You'll know after 4 weeks.

**Phase 2 (Weeks 7–12, 20–50 customers):** Switch to FirstPromoter ($49/mo).
- Cost: $49/mo. Time: <10 min/mo (Slack notifications handle the rest).
- 5–15 active creators, each earning £18–50/mo. Self-serve signup reduces friction.

**Phase 3 (6+ months, 50+ customers):** Rewardful ($99/mo) or Tolt.
- Scale to 30+ creators. Automate payouts. Let creators compete.

---

## 3. Affiliate Landing Page Copy

**URL:** stockportfolio.pro/affiliates

**Page structure:**

```html
<!-- HERO -->
<h1>Help your audience research better. Earn 30% recurring.</h1>
<p>If you already recommend investment research tools to your audience, 
   Stock Portfolio Pro is the easiest add—deep SEC data, AI that cites sources, 
   fair pricing. Earn £447/year per Desk customer, or £30–270/year per Core/Pro subscriber. 
   No clicks-to-cash — only real conversions count.</p>

<a href="[SIGNUP LINK]" class="btn btn-primary">Become an Affiliate</a>

<!-- TWO-TIER TABLE -->
<h2>What you'll earn</h2>

<table>
  <tr>
    <th>Product tier</th>
    <th>Customer price</th>
    <th>Your annual commission</th>
    <th>How it works</th>
  </tr>
  <tr>
    <td>Core (£9/mo)</td>
    <td>£108/yr</td>
    <td>£32.40/yr (30%)</td>
    <td>Recurring — paid as long as they stay</td>
  </tr>
  <tr>
    <td>Pro (£25/mo)</td>
    <td>£300/yr</td>
    <td>£90/yr (30%)</td>
    <td>Recurring — paid as long as they stay</td>
  </tr>
  <tr>
    <td>Desk (£1,490/yr)</td>
    <td>£1,490/yr</td>
    <td>£447/yr (30%)</td>
    <td>One sale = one year of affiliate earnings</td>
  </tr>
</table>

<!-- WHY IT WORKS -->
<h2>Why creators choose us</h2>

<ul>
  <li><strong>Deep history, simple UX.</strong> 19 years of SEC fundamentals for 1,500 companies. 
      Screener, charts, filings, AI Q&A. No login wall on the screener—works for your cold traffic.</li>
  <li><strong>AI that doesn't hallucinate.</strong> The Ask assistant refuses to guess; 
      every answer is sourced to a filing. Shows your audience you care about accuracy.</li>
  <li><strong>Fair pricing, no tricks.</strong> £9/mo is 3x cheaper than TIKR/Koyfin. 
      No upsell games, no surprise cancellations—your credibility stays clean.</li>
  <li><strong>We ship daily.</strong> You recommend it once; we keep improving it. 
      Your audience gets better research, you keep earning as they upgrade.</li>
  <li><strong>Solo founder, solo developer.</strong> No corporate BS. 
      Bug report? You'll get a fix, not a ticket system.</li>
</ul>

<!-- FAQ -->
<h2>Questions</h2>

<details>
  <summary><strong>How do I get my unique link?</strong></summary>
  <p>Sign up below, you'll get a dashboard with your referral code and landing URL 
     (e.g., stockportfolio.pro/?ref=yourname). Share it with your audience however fits—
     YouTube description, blog, newsletter, Discord, etc. No talking points needed; 
     honest mention works best.</p>
</details>

<details>
  <summary><strong>How long does the cookie last?</strong></summary>
  <p>120 days. If someone clicks your link and signs up within 4 months, you earn the commission. 
     Long enough to account for the research phase; short enough to prevent fraud.</p>
</details>

<details>
  <summary><strong>When do I get paid?</strong></summary>
  <p>Monthly, net-30. If you earned £50+ in a month, we'll pay you between the 1st–15th 
     of the next month. You pick: bank transfer (£50 minimum) or hold and accumulate.</p>
</details>

<details>
  <summary><strong>What if a customer cancels?</strong></summary>
  <p>You earned the commission for each month they were active. If they were subscribed 8 months, 
     you get 8 months of 30% recurring. If they cancel, future months don't pay—that's standard recurring affiliate.</p>
</details>

<details>
  <summary><strong>Can I promote both Desk and Core?</strong></summary>
  <p>Absolutely. Desk (£1,490/yr) is for analysts and RIAs. Core/Pro is for retail investors. 
     You know your audience best. If you have a mixed crowd, link to the landing page and let them pick.</p>
</details>

<details>
  <summary><strong>Do I need to disclose the affiliate relationship?</strong></summary>
  <p>Yes. FTC requires it (US) / ASA requires it (UK). Something like "This is an affiliate link; 
     I earn a commission if you sign up" works. We respect transparency—your audience will too.</p>
</details>

<details>
  <summary><strong>What if it's a bad fit for my audience?</strong></summary>
  <p>Tell us why. We'll either fix it or agree it's not for you—no pressure. 
     Best affiliate programs only pay on real recommendations, and we mean it.</p>
</details>

<!-- SOCIAL PROOF -->
<h2>Who's already earning</h2>

<p><em>(Optional: add creator quote + payout amount once you have 5+ active affiliates. 
   Don't add fake testimonials.)</em></p>

<!-- CTA -->
<h2>Ready?</h2>

<p>Sign up below. You'll get your link, dashboard, and all the creatives you need. 
   Go recommend good research to your people.</p>

<a href="[SIGNUP LINK]" class="btn btn-primary btn-lg">Become an Affiliate</a>

<p><em>Questions? Email <a href="mailto:avinash@stockportfolio.pro">avinash@stockportfolio.pro</a></em></p>
```

**Tone notes:**
- No em-dashes, contractions OK ("I'll", "We'll"), avoid "genuinely" or "it's not X it's Y"
- Lead with the pain your competitors solve (big gap in earnings per customer), not the product
- Emphasize "recurring" — shows it's not a one-time payout
- Be honest about cookie duration, payment terms, cancellation risk (builds trust)

---

## 4. Affiliate Recruitment Email

**Purpose:** Send to proven creators who monetize competing tools (Koyfin, TIKR, Stock Rover, Sharesight).

**Subject line:** Two versions (test both)
- **V1 (value-first):** "30% recurring — better economics than [their current tool]"
- **V2 (curiosity):** "Your audience just asked about this (and we have the answer)"

**Email template (personalize every send):**

```
Subject: 30% recurring — better economics than Stock Rover

Hi [name],

I watched your recent video on [SPECIFIC TITLE]. You mentioned 
stock screeners and fundamental data—that's the gap we fill.

I'm Avinash, solo founder of Stock Portfolio Pro. We offer 19 years 
of SEC fundamentals for 1,500 US companies, a no-login screener, 
AI Q&A that refuses to guess, and the filing-change Monitor (the job 
AlphaSense charges $10k–$40k for). Priced at £9/mo.

Where this works for you: your audience asks about the TIKR/Koyfin 
trade-off all the time. We're 3x cheaper, same history, better AI 
sourcing. And the commission math is better than Stock Rover:

   Stock Rover affiliate: 25% of £[their annual price]
   Stock Portfolio Pro affiliate: 30% recurring, per customer
   
At £9/mo, a customer is £32/year to you, recurring, for as long 
they stay. One Desk sale (£1,490/yr) is £447/year.

No pressure to recommend something you're not sold on. I'd rather 
you judge it honestly first:

1. Free Pro account—use it, tear it apart, tell me what's missing
2. Link to your audience whenever it fits
3. Earn 30% recurring on anyone who signs up (120-day window)

Two links:
- Try the Monitor: https://www.stockportfolio.pro/monitor (0 login)
- Your affiliate dashboard: [PLATFORM LINK — Rewardful or manual code]

If it doesn't fit, no hard feelings. But I think your people will 
actually use this one.

Avinash
stockportfolio.pro

---
P.S. — If you'd rather do a sponsorship + affiliate combo, we can 
structure that instead. But affiliate-only usually works better 
(you only pay on a real sale, I don't waste money on ads that convert 0).
```

**Variants by creator type:**

**For YouTubers (tech-focused):**
```
Subject: 30% recurring affiliate — would work for your audience

I saw your recent comparison video on TIKR vs Koyfin. 

Stock Portfolio Pro fills the same gap (19y SEC data, screener, AI). 
£9/mo, affiliate link in description. Your viewers will ask about us 
after they see the comparison.

30% recurring (that's £32–90/yr per customer, or £447 per Desk sale).

Free Pro for you to test. Let me know if you want the affiliate link.

Avinash
```

**For Newsletter Writers (analyst / research angle):**
```
Subject: The filing-change job Bloomberg charges $32k for, at £1,490/yr

Your readers live in the filings. The Filing Change Monitor emails 
them what materially changed each 10-K/10-Q, ranked, every number sourced.

This is the job AlphaSense ($10k–$40k) and Bloomberg ($31,980) charge 
for, and Koyfin/TIKR don't do at all.

30% recurring (that's £447/year per Desk customer). Perfect for a 
sponsorship angle: "Here's what I use to save 10 hours/mo."

Free Desk account + link in your affiliate dashboard.

Avinash
```

**For Bloggers (SEO angle):**
```
Subject: Affiliate offer — Stock Portfolio Pro (TIKR/Stock Rover alternative)

Your "Best Stock Screeners" post ranks well. Stock Portfolio Pro 
would be a strong add—it's cheaper than TIKR/Koyfin, has deeper 
history than most, and actually has an affiliate program (rare at 
this price point).

30% recurring affiliate. Free account to try.

Avinash
```

---

## 5. Go-Live Checklist

- [ ] Decide: Coupon codes (Phase 1) or FirstPromoter (Phase 2)?
- [ ] Create 3–5 test coupon codes in Stripe (if Phase 1)
  - [ ] "TOM_INVESTING", "MAYNARD_PATON", "LIBERATED_TRADER", "MODEST_MONEY", "FINMASTERS"
- [ ] Create tracker.md sheet (or Google Sheets):
  - [ ] Creator name | Coupon code | # signups | # conversions | £ earned | Status
- [ ] Draft landing page copy (above) to `/marketing/affiliate-landing.html` or update `stockportfolio.pro/affiliates`
- [ ] Pick email template (use V2 for your first batch, test subject lines after 5 sends)
- [ ] Export target list from `outreach.md` (Tier 1 retail creators × 5–8)
- [ ] Send first batch of 5 recruitment emails (personalize, wait for replies before next batch)
- [ ] Log each send in tracker.md (date, creator, subject, reply status)
- [ ] Wait 1 week, follow up with non-replies (don't spam)
- [ ] After 4 weeks, review which creators drove conversions (metrics) and which didn't
- [ ] If >5 active creators, evaluate upgrade to FirstPromoter (budget $49/mo)

---

## 6. Year 1 Projection

**Month 1–3 (launch phase):**
- 5 active affiliates
- 2–3 conversions/mo total
- Cost: £0 (manual tracking)
- Revenue from affiliates: £60–90/mo

**Month 4–6 (traction):**
- 8–10 active affiliates (referrals from early wins)
- 8–12 conversions/mo
- Cost: $49/mo (FirstPromoter) if you hit this
- Revenue from affiliates: £240–360/mo

**Month 7–12:**
- 12–15 active affiliates (some drop, new recruits)
- 15–25 conversions/mo
- Affiliate costs: ~£250–350/mo (30% of affiliate revenue)
- Affiliate revenue to you: £800–1,200/mo (after commissions)

**By end of year 1:**
- Affiliates drive ~20% of trial signups (rest: organic/Reddit/HN)
- ~30% affiliate trial → paid conversion (matches organic)
- Estimated affiliate revenue: ~£10k gross (affiliates earned ~£3.5k; you kept £6.5k)

This assumes you send 10–15 personalized emails in week 1 and actively track replies.

---

## 7. Edge Cases & Gotchas

**Q: What if a creator promotes Desk but has a mostly-retail audience?**
A: They won't close Desk sales. But they'll promote Core/Pro, and you'll earn your 30% anyway. Let them find their angle.

**Q: Can I do tiered commissions (higher % for higher volume)?**
A: Yes. Use Rewardful's "bonus tiers" (e.g., 30% base → 35% after 5 sales/mo). But start flat; tiering adds complexity without proof of lift.

**Q: Do I need to cap payouts?**
A: No. If a creator drives £1,000/mo in affiliate revenue, pay them £300/mo. That's a win—affiliate marketing is working.

**Q: What if a creator references our product on Reddit and earns affiliate credit?**
A: You can't track Reddit anonymously. Use coupon codes for Reddit-heavy creators (they'll mention "use code CREATOR_20").

**Q: Affiliate fraud — what if someone clicks their own link 100 times?**
A: Rewardful/FirstPromoter flag this (same IP, rapid clicks). Manual tracking requires you to eye-ball odd patterns. One creator signing up 50 accounts in an hour is sus.

**Q: Can I ask affiliates not to bid on brand keywords (e.g., Google Ads)?**
A: Only if you have an affiliate agreement (Rewardful includes this). Manual coupon approach = no legal enforceable agreement. You'll need to add T&Cs to your landing page.

---

**Version:** 2026-06-19  
**Author:** Avinash (solo founder)  
**Next review:** After first 20 affiliate signups, gather metrics on conversion rate and payout efficiency.
