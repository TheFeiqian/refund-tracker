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

async function callAnthropic(apiKey, { system, userText, image }) {
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
    max_tokens: 1024,
    messages: [{ role: 'user', content }],
  };
  if (system) body.system = system;

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
        system: 'You read UK postage / proof-of-postage receipts. Extract fields and reply with ONLY a JSON object.',
        userText: 'Extract these from this postage receipt image and return ONLY JSON with these keys (use empty string if not visible): '
          + '{"postage_date":"DD/MM/YYYY","outbound_tracking":"","outbound_courier":"Royal Mail|Parcelforce|DPD|Evri|DHL|Yodel|UPS|FedEx|other","posted_from":"the Post Office / parcelshop / drop-off location"}.',
        image: { image_base64: payload.image_base64, media_type: payload.media_type },
      });
      return res.status(200).json({ fields: jsonFromText(text) || {} });
    }

    if (task === 'parse_label') {
      const text = await callAnthropic(apiKey, {
        system: 'You read shipping return labels. Extract fields and reply with ONLY a JSON object.',
        userText: 'Extract from this return-label image and return ONLY JSON (empty string if not visible): '
          + '{"outbound_tracking":"","outbound_courier":"Royal Mail|Parcelforce|DPD|Evri|DHL|Yodel|UPS|FedEx|other","return_label_date":"DD/MM/YYYY"}.',
        image: { image_base64: payload.image_base64, media_type: payload.media_type },
      });
      return res.status(200).json({ fields: jsonFromText(text) || {} });
    }

    if (task === 'parse_order') {
      const text = await callAnthropic(apiKey, {
        system: 'You read order confirmation emails / receipts. Extract fields and reply with ONLY a JSON object.',
        userText: 'Extract from this order confirmation and return ONLY JSON (empty string if not visible): '
          + '{"store":"","items":"","store_order_number":"","price":0,"email":"","phone":"","address":"","order_date":"DD/MM/YYYY"}.',
        image: { image_base64: payload.image_base64, media_type: payload.media_type },
      });
      return res.status(200).json({ fields: jsonFromText(text) || {} });
    }

    if (task === 'store_autofill') {
      const text = await callAnthropic(apiKey, {
        system: 'You provide UK retailer returns information. Reply with ONLY a JSON object. If unsure of a value, use an empty string and never invent specific phone numbers or emails you are not confident about.',
        userText: 'For the UK retailer "' + (payload.store || '') + '", return ONLY JSON: '
          + '{"website":"","phone":"","email":"","portal":"returns portal URL if any","chat":true,"returns_policy":"one-sentence summary of their returns policy"}.',
      });
      return res.status(200).json({ fields: jsonFromText(text) || {} });
    }

    return res.status(400).json({ error: 'unknown task: ' + task });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
