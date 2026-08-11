# GA4/Clarity manual checklist

* Keep browser tags behind `sp_analytics_consent_v1`.
* Create the GA4 custom dimensions listed in `growth-measurement.md`.
* Validate Measurement Protocol in development using `/debug/mp/collect`.
* Confirm `sign_up`, `purchase`, `refund` and `activation_completed` are the
  only conversion candidates; browser clicks remain intent.
* Confirm Clarity masks inputs and does not receive raw user identifiers.
* Never commit `GA4_API_SECRET`; configure it in Render/local secrets only.
