// Secure Anthropic proxy — runs server-side on Vercel. The API key lives ONLY in the
// Vercel environment variable ANTHROPIC_API_KEY, never in the browser or the repo.
//
// The browser POSTs { task, ...payload } and gets back structured JSON. Supported tasks:
//   estimate_wv          -> { prompt }                 -> { result: [{weight,volume}, ...] }
//   parse_postage        -> { image_base64, media_type } -> { fields: {postage_date, outbound_tracking, outbound_courier, posted_from} }
//   parse_label          -> { image_base64, media_type } -> { fields: {outbound_tracking, outbound_courier, return_label_date} }
//   parse_order          -> { image_base64, media_type } -> { fields: {store, items, store_order_number, price, email, phone, address, order_date} }
//   store_autofill       -> { store }                  -> { fields: {website, phone, email, portal, chat, returns_policy} }
//
// Configure in Vercel: Project → Settings → Environment Variables → ANTHROPIC_API_KEY.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';

function jsonFromText(text) {
  if (!text) return null;
  // strip code fences and grab the first {...} or [...] block
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const m = cleaned.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

async function callAnthropic(apiKey, { system, userText, image, webSearch }) {
  const content = [];
  if (image && image.image_base64) {
    const mt = image.media_type || 'image/jpeg';
    if (mt === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image.image_base64 } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: image.image_base64 } });
    }
  }
  content.push({ type: 'text', text: userText });

  const body = {
    model: MODEL,
    max_tokens: webSearch ? 2048 : 1024,
    messages: [{ role: 'user', content }],
  };
  if (system) body.system = system;
  if (webSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || ('Anthropic ' + r.status));
  // With web search the response has multiple text blocks (search + answer) — join them all.
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return text;
}

module.exports = async (req, res) => {
  // CORS (same-origin in practice, but harmless to allow the app origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server' });

  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
  payload = payload || {};
  const task = payload.task;

  try {
    if (task === 'estimate_wv') {
      const text = await callAnthropic(apiKey, {
        system: 'You are a logistics estimator. Reply with ONLY the requested JSON, no prose.',
        userText: payload.prompt || '',
      });
      return res.status(200).json({ result: jsonFromText(text) });
    }

    if (task === 'parse_postage') {
      const text = await callAnthropic(apiKey, {
        system: 'You read UK proof-of-postage receipts and drop-off confirmations. Reply with ONLY a JSON object, no prose.\n'
          + 'FIELD RULES:\n'
          + '- "postage_date": the date of posting shown on the receipt, format DD/MM/YYYY. If the image is a photo with NO printed/visible date, return "" (the app will use the photo date).\n'
          + '- "posted_from": the shop / Post Office / ParcelShop branch NAME plus its FULL address and postcode exactly as printed, joined with ", " (include every address line you can read).\n'
          + '- "outbound_courier": Royal Mail | Parcelforce | DPD | Evri | DHL | Yodel | UPS | FedEx | other.\n'
          + '- "outbound_tracking": a postage receipt usually shows REFERENCE / BARCODE numbers that are NOT the same as the parcel tracking number, and may show shop IDs or helpline phone numbers. Only return a value here if you can clearly read a genuine parcel tracking/reference number; otherwise return "". NEVER return a phone number (UK numbers start 01/02/03/07/08 or +44), a shop/FAD/branch ID, a session number, or a transaction number as tracking.\n'
          + 'LAYOUT EXAMPLES (these are the receipt types you will see):\n'
          + '1) Post Office "Certificate of Posting": header "Post Office Ltd", branch address near the top (e.g. "23 Bartholomew Street, London, SE1 4AL"), lines for "Barcode Number" and "Track ID", a "Session" line, footer "this is not a VAT receipt". posted_from = the branch name + that address.\n'
          + '2) Collect+ / Royal Mail ParcelShop "CUSTOMER PARCEL RECEIPT": "collect+" logo, a "parcels made easy" number (a shop ID, NOT tracking), the shop name + postcode (e.g. "HEALTHY-ISH SUPERMARKET WC1X 9LR"), date, then SEVERAL "Reference Number:" lines. Do not assume any of these is the tracking number — if unsure return "" for tracking. posted_from = the shop name + postcode.\n'
          + '3) Phone-screen "Customer Drop Off" confirmation: a message like "<code> has already been scanned into the shop". There is usually no printed date here — return "" for postage_date and use the visible shop/location for posted_from if shown.\n'
          + 'If the image is rotated, read it in whatever orientation makes the text legible.',
        userText: 'Extract from this proof-of-postage image. Return ONLY JSON: '
          + '{"postage_date":"DD/MM/YYYY or empty","outbound_tracking":"genuine tracking only, else empty","outbound_courier":"one of the listed couriers or empty","posted_from":"branch/shop name + full address joined with commas"}.',
        image: { image_base64: payload.image_base64, media_type: payload.media_type },
      });
      return res.status(200).json({ fields: jsonFromText(text) || {} });
    }

    if (task === 'parse_label') {
      const text = await callAnthropic(apiKey, {
        system: 'You read UK shipping RETURN LABELS (the label printed to send a parcel back). Reply with ONLY a JSON object, no prose.\n'
          + 'FIELD RULES:\n'
          + '- "outbound_tracking": the parcel tracking / consignment number on the label. Courier formats vary — examples of REAL valid formats:\n'
          + '    Royal Mail: 2 letters + 9 digits + "GB" (e.g. ZR786964745GB) or similar; also seen as "HI0060 45416GB".\n'
          + '    Parcelforce: like "HI000604 5416GB".\n'
          + '    DPD: a long mostly-digit number, often spaced in groups (e.g. "1597 6914 4815 429", "1550 1959 6349 69M") — return it WITHOUT the spaces.\n'
          + '    Evri/Hermes: hyphenated alphanumeric (e.g. "H-00JP-D-000017160-5").\n'
          + '    FedEx: a 12-22 digit number (e.g. 0430287517890853).\n'
          + '    UPS: starts "1Z" (e.g. 1ZV846V79197286215).\n'
          + '    Some labels (notably Yodel and DHL examples) show NO readable tracking number — in that case return "" for outbound_tracking.\n'
          + '  Remove internal spaces from the tracking number. Never return a phone number, address, or postcode as tracking.\n'
          + '- "outbound_courier": identify from the logo / wording — one of Royal Mail | Parcelforce | DPD | Evri | DHL | Yodel | UPS | FedEx | other.\n'
          + '- "return_label_date": only if a date is actually printed on the label (DD/MM/YYYY); otherwise return "" (the app will use the label file date).\n'
          + 'If the image is rotated, read it in whatever orientation makes the text legible.',
        userText: 'Extract from this return-label image. Return ONLY JSON (empty string if genuinely not present): '
          + '{"outbound_tracking":"tracking with spaces removed, else empty","outbound_courier":"one of the listed couriers or empty","return_label_date":"DD/MM/YYYY if printed, else empty"}.',
        image: { image_base64: payload.image_base64, media_type: payload.media_type },
      });
      return res.status(200).json({ fields: jsonFromText(text) || {} });
    }

    if (task === 'parse_order') {
      const text = await callAnthropic(apiKey, {
        system: 'You read order confirmation emails / receipts. Extract fields exactly as printed and reply with ONLY a JSON object, no prose. '
          + 'CRITICAL: "order_date" must be the order/purchase date PRINTED ON THE DOCUMENT (look for "Order date", "Ordered on", "Placed on", or the date next to the order number). '
          + 'NEVER use today\'s date and NEVER guess — if no order date is visible on the document, return an empty string for order_date. '
          + '"address" must be the FULL delivery address: every line plus the postcode, joined with ", " (not just the first line). '
          + '"price" is the order total as a number (no currency symbol). "store" is the retailer/brand name.',
        userText: 'Extract from this order confirmation. Return ONLY JSON (empty string / 0 if a value is genuinely not present): '
          + '{"store":"","items":"","store_order_number":"","price":0,"email":"","phone":"","address":"full multi-line delivery address joined with commas","order_date":"DD/MM/YYYY exactly as printed on the document, else empty"}.',
        image: { image_base64: payload.image_base64, media_type: payload.media_type },
      });
      return res.status(200).json({ fields: jsonFromText(text) || {} });
    }

    if (task === 'store_autofill') {
      const text = await callAnthropic(apiKey, {
        webSearch: true,
        system: 'You research UK retailer returns + contact information for a returns-processing tool. USE WEB SEARCH to find the retailer\'s official website and read their actual contact / customer-service / returns pages. '
          + 'The phone number and email MUST come from the retailer\'s real official site or a clearly authoritative source you found via search — do NOT recall from memory and do NOT guess. If after searching you cannot confirm the official customer-service phone number, return "" for phone rather than a number you are unsure about. The same applies to email. '
          + 'After any searching, your FINAL message must be ONLY the JSON object and nothing else.',
        userText: 'Research the UK retailer "' + (payload.store || '') + '"' + (payload.website ? (' (website ' + payload.website + ')') : '') + ' by searching the web and reading their official site. Then return ONLY this JSON:\n'
          + '{'
          + '"website":"official UK website URL",'
          + '"contact_form":"URL of their GENERAL customer-service / contact / help enquiry form — the page used to ask a question or raise a general query. This is NOT the returns page. Empty if none.",'
          + '"returns_form":"URL of the form used SPECIFICALLY to start or request a return / RMA — the page a customer uses to return an item. This is NOT the general contact form. Empty if none.",'
          + '"returns_portal":"URL of a self-service returns PORTAL if distinct from the returns form, else empty",'
          + '"phone":"official UK customer-service phone from their site, else empty",'
          + '"email":"official customer-service email from their site, else empty",'
          + '"live_chat":true/false,'
          + '"parcel_shop_unwanted":true/false (free parcel-shop/drop-off return label for UNWANTED items),'
          + '"parcel_shop_damaged":true/false (parcel-shop/drop-off label for DAMAGED items),'
          + '"offers_collection":true/false (home collection for returns),'
          + '"category":["one or more of: Furniture, Electronics, Fashion, Homeware, Garden, Beauty, Sports, Other"],'
          + '"revenue":"approximate most-recent annual revenue as a short string e.g. \\"£120M\\", else empty",'
          + '"revenue_over_2m":true/false,'
          + '"notes":"one short sentence on their returns policy"'
          + '}. IMPORTANT: contact_form and returns_form are DIFFERENT pages — never put the same URL in both, and never put a returns URL in contact_form or vice versa. If you are unsure which one a page is, leave the less certain one empty.',
      });
      return res.status(200).json({ fields: jsonFromText(text) || {} });
    }

    if (task === 'company_revenue') {
      const text = await callAnthropic(apiKey, {
        webSearch: true,
        system: 'You research approximate company revenue for a business-eligibility check. USE WEB SEARCH to find a recent, authoritative figure (company filings, Companies House, reputable business sources). Do not guess. If you cannot find a credible figure after searching, set known=false and leave revenue empty. '
          + 'After any searching, your FINAL message must be ONLY the JSON object and nothing else.',
        userText: 'Research the most recent annual revenue of the company "' + (payload.store || payload.company || '') + '"' + (payload.website ? (' (' + payload.website + ')') : '') + ' by searching the web. Then return ONLY JSON: '
          + '{"revenue":"approximate most-recent annual revenue as a short string e.g. \\"£120M\\", else empty","revenue_over_2m":true/false,"known":true/false,"source_note":"one short sentence naming the source / basis"}.',
      });
      return res.status(200).json({ fields: jsonFromText(text) || {} });
    }

    if (task === 'analyze_photo') {
      const kind = payload.kind === 'damage' ? 'damage' : 'delivery';
      const sys = kind === 'damage'
        ? 'You inspect a photo a customer says shows a DAMAGED item being returned. Reply with ONLY a JSON object, no prose. Decide whether visible damage to the item is actually shown.'
        : 'You inspect a parcel PROOF-OF-DELIVERY photo (the photo a courier takes when leaving a parcel). Reply with ONLY a JSON object, no prose. Decide whether a person (the recipient receiving/holding the parcel) is visible, versus just a doorstep / porch / package on the ground.';
      const ask = kind === 'damage'
        ? 'Return ONLY JSON: {"damage_visible":"yes" or "no","note":"a few words on what is or isn\'t visible"}.'
        : 'Return ONLY JSON: {"shows_person":"yes" or "no","note":"a few words on what the photo shows"}.';
      const text = await callAnthropic(apiKey, {
        system: sys,
        userText: ask,
        image: { image_base64: payload.image_base64, media_type: payload.media_type },
      });
      return res.status(200).json(jsonFromText(text) || {});
    }

    return res.status(400).json({ error: 'unknown task: ' + task });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
