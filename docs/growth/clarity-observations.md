# Microsoft Clarity observations

Snapshot: 21 August 2026. Source: authenticated, read-only access to the StockPortfolio.pro Clarity project. No settings or recordings were changed.

## Current aggregate signal

For the latest three-day window, Clarity showed:

- 31 human sessions and 86 bot sessions excluded;
- 30 unique users;
- 25 new and 6 returning sessions/users as presented by Clarity;
- 1.19 pages per session;
- 57.89% average scroll depth;
- 0 rage-click sessions;
- 1 dead-click session (3.23%);
- 0 excessive-scroll sessions;
- 1 quick-back session (3.23%).

The bot count is larger than the human-session count. Raw request or session growth must therefore not be presented as audience growth without the platform's bot filtering.

## Ten-recording sample

The sample is purposive, not random: it was selected to cover recent search, X, direct/unknown and in-product sessions from 19–21 August. It is useful for finding failure modes, but it does not estimate population rates. Typed text, identities, user IDs, locations and click-target text were not inspected or recorded.

| Alias | Source | Landing/page family | Buyer status | Observed behavior | Friction | Interpretation |
|---|---|---|---|---|---|---|
| S01 | Yahoo search | CBOE free-cash-flow metric page | Unknown anonymous visitor | One page, zero clicks; page hidden after 12 seconds | None recorded | The nominal 17-minute duration was idle/background time, not engagement. |
| S02 | Bing search | INVH total-debt metric page | Unknown anonymous visitor | Same route loaded twice, zero clicks; hidden almost immediately | None recorded | Search landing was reopened or reloaded, but did not lead to deeper navigation. |
| S03 | Google search | DINO-vs-SUN comparison | Unknown anonymous visitor | One page, one click, about one minute | None recorded | Only sampled search visit with an interaction; it stayed on the comparison route. |
| S04 | X (`t.co`) | Homepage | Unknown anonymous visitor | One page, one click, about 90 seconds | None recorded | Brief homepage engagement, but no second-page navigation. |
| S05 | Direct/unknown | Homepage to company page | Unknown | Four pages and five clicks across a nominal nine-minute session | One quick-back | Deepest cross-page visit in the sample; activity followed a long idle gap. Direct remains unknown. |
| S06 | Internal referrer | Screener | Unknown; potentially internal | Active filter interaction; 22 click events and three input-edit events | One dead click | A real interaction-control issue may exist, but the exact control requires focused owner QA. |
| S07 | Direct/unknown | Authenticated portfolio dashboard | Authenticated; payment status not joined | Same route revisited; one click | Hidden for most of the nominal 17 minutes | Open-tab time materially overstates active use. |
| S08 | Internal dashboard navigation | Ask | Authenticated; payment status not joined | Two clicks and nine input-edit events over about four minutes | None recorded | Strongest sampled evidence of active product work. Input edits are not equivalent to nine questions. |
| S09 | Internal Ask navigation | Dossier | Authenticated; payment status not joined | One page, zero clicks, about one minute | None recorded | Passive result reading or waiting; no recorded follow-on action. |
| S10 | Internal referrer | Screener | Unknown; possibly QA | 63 click events and four input-edit events, concentrated in the first 71 seconds | None recorded | Atypical and possibly QA-like. Exclude from growth conclusions unless independently classified as external. |

## Repeated patterns

1. **External traffic was shallow in this sample.** Three search sessions produced one recorded click and no cross-page navigation. The X visit produced one click and stayed on the homepage.
2. **True cross-page exploration was rare.** One of ten sessions showed meaningful cross-route discovery. Seven were single-page; the other two multi-page counts were same-route reloads or revisits.
3. **Duration is a poor engagement proxy.** At least six sessions were hidden or backgrounded early. Use active time, verified actions and page depth instead.
4. **Ask showed the clearest active product behavior.** The Dossier handoff looked shorter and more passive in this sample.
5. **Click totals were highly concentrated.** Two screener sessions produced 85 of 95 sampled click events (89%). Aggregate clicks must not be interpreted as broad engagement.
6. **Observed friction was limited but real.** One dead-click session and one quick-back appeared. No JavaScript-error, rage-click or excessive-scroll event appeared in the ten sessions; that is not proof the product is error-free.

## Actionable implication

The immediate behavior problem is landing-to-next-step discovery, not a demonstrated need for another feature. Improve the clarity of the next research action on search and X landing pages, and separately reproduce the screener dead click. Measure active behavior rather than nominal session duration.

## Why this might be wrong

- Ten recordings are too few for rate estimates.
- The selection deliberately included different sources and product states, so it is not representative.
- Internal or QA sessions may remain even after manual classification.
- Clarity event labels can overcount repeated UI activity and do not prove commercial intent.
- Privacy restrictions intentionally prevent linking these recordings to known customers or purchase outcomes.
