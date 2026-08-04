// Knowledge base of approved retailer-reply scenarios (the AI checks this before drafting, and
// learns from every human-approved answer). Service-role so it's shared across the team.
//
// GET                          -> { scenarios:[...] }
// POST { scenario:{...} }       -> add / learn a scenario -> { scenario }
const { listKb, addKb } = require('./_util');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const scenarios = await listKb();
      return res.status(200).json({ scenarios });
    }
    if (req.method === 'POST') {
      let payload = req.body;
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
      payload = payload || {};
      const s = payload.scenario || {};
      if (!s.question || !s.approved_answer) return res.status(400).json({ error: 'question and approved_answer required' });
      const row = {
        retailer_category: s.retailer_category || '',
        question: String(s.question).slice(0, 2000),
        approved_answer: String(s.approved_answer).slice(0, 8000),
        required_docs: s.required_docs || '',
        outcome: s.outcome || '',
        kind: s.kind || 'known',
      };
      const scenario = await addKb(row);
      return res.status(200).json({ ok: true, scenario });
    }
    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e), scenarios: [] });
  }
};
