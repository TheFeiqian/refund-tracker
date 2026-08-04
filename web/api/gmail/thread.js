// Read / update a claim's stored conversation (service-role, so retailer bodies never touch the anon key).
//
// GET  ?order_id=...            -> { messages:[...] }  ordered oldest-first
// POST { id, patch:{...} }      -> update one message (edit suggestion, change status, mark replied)
const { getMessages, updateMessage } = require('./_util');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const orderId = url.searchParams.get('order_id');
      if (!orderId) return res.status(400).json({ error: 'order_id required', messages: [] });
      const messages = await getMessages(orderId);
      return res.status(200).json({ messages });
    }
    if (req.method === 'POST') {
      let payload = req.body;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
      payload = payload || {};
      const { id, patch } = payload;
      if (!id || !patch) return res.status(400).json({ error: 'id and patch required' });
      const allowed = {};
      ['status', 'ai_suggestion', 'ai_outcome'].forEach(k => { if (patch[k] !== undefined) allowed[k] = patch[k]; });
      await updateMessage(id, allowed);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e), messages: [] });
  }
};
